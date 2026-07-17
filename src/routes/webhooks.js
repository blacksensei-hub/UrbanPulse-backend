import express from 'express';
import { verifyWebhookSignature } from '../utils/paystackHelper.js';
import { tx, query } from '../db/index.js';
import { sendEmail, emailTemplates } from '../utils/email.js';
import { sendSMS, smsTemplates } from '../utils/sms.js';
import { logger } from '../utils/logger.js';
import { checkAndQualifyReferral } from '../utils/referral.js';
import { awardPointsForOrder } from '../utils/loyalty.js';
import { getSettings } from '../utils/settingsCache.js';

const router = express.Router();

// IMPORTANT: this router is mounted with express.raw() in server.js so req.body is a Buffer.
// Paystack signs the raw body with HMAC-SHA512 and sends the digest in `x-paystack-signature`.
router.post('/paystack', async (req, res) => {
  const sig = req.headers['x-paystack-signature'];
  const raw = req.body; // Buffer

  if (!verifyWebhookSignature(raw, sig)) {
    logger.warn('Paystack webhook signature verification failed');
    return res.status(401).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    logger.warn(`Paystack webhook body parse failed: ${err.message}`);
    return res.status(400).send('Invalid body');
  }

  // The essential path (DB transaction + notifications + referral qualify) is awaited
  // BEFORE responding — on serverless (Vercel), the platform can freeze/terminate the
  // function as soon as the response is sent, so any work left running after res.json()
  // is not guaranteed to complete. Paystack tolerates several seconds here, so the extra
  // latency is worth the reliability. We still always return 200 (Paystack retries on
  // non-2xx, which wouldn't fix a code bug anyway) — but only after doing the work, or
  // after logging loudly why it failed.
  try {
    if (event?.event === 'charge.success' && event?.data?.reference) {
      const reference = event.data.reference;
      const order = await tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE orders
              SET payment_status = 'paid', status = 'processing'
            WHERE paystack_reference = $1
              AND payment_status <> 'paid'
            RETURNING *`,
          [reference]
        );
        const ord = rows[0];
        if (ord) {
          await c.query(
            'INSERT INTO order_status_history (order_id, status, note) VALUES ($1, $2, $3)',
            [ord.id, 'paid', 'Payment confirmed via Paystack']
          );
          await c.query(
            'INSERT INTO order_status_history (order_id, status, note) VALUES ($1, $2, $3)',
            [ord.id, 'processing', null]
          );
          await awardPointsForOrder(c, ord);
        }
        return ord;
      });
      if (order) {
        const email = order.email || order.shipping_address?.email;
        const phone = order.phone || order.shipping_address?.phone;
        if (email) {
          const { rows: items } = await query(
            'SELECT product_name, unit_price, variant_description, product_image, quantity FROM order_items WHERE order_id = $1',
            [order.id]
          );
          const { rows: couponRows } = await query(
            'SELECT discount_amount FROM order_coupons WHERE order_id = $1 LIMIT 1',
            [order.id]
          );
          const couponDiscount = couponRows[0] ? Number(couponRows[0].discount_amount) : 0;
          const cfg = await getSettings();
          const expressRateGhs = Number(cfg.shipping_express_ghs ?? 80);
          await sendEmail({ to: email, ...emailTemplates.orderConfirmation(order, items, { couponDiscount, expressRateGhs }) })
            .catch((err) => logger.error('Order confirmation email failed', { orderId: order.id, err: err.message }));
        }
        if (phone) {
          await sendSMS({ to: phone, message: smsTemplates.paid(order) })
            .catch((err) => logger.error('Order confirmation SMS failed', { orderId: order.id, err: err.message }));
        }
        await checkAndQualifyReferral(order.id, order.user_id).catch((err) =>
          logger.error(`Referral qualify error (order ${order.id}): ${err.message}`)
        );
      }
    }
  } catch (err) {
    logger.error('Paystack webhook handling error', {
      event: event?.event,
      reference: event?.data?.reference,
      err: err.message,
      stack: err.stack,
    });
  }

  res.json({ received: true });
});

export default router;
