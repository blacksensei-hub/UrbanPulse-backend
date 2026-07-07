import express from 'express';
import { verifyWebhookSignature } from '../utils/paystackHelper.js';
import { tx, query } from '../db/index.js';
import { sendEmail, emailTemplates } from '../utils/email.js';
import { sendSMS, smsTemplates } from '../utils/sms.js';
import { logger } from '../utils/logger.js';
import { checkAndQualifyReferral } from '../utils/referral.js';
import { awardPointsForOrder } from '../utils/loyalty.js';

const router = express.Router();

// IMPORTANT: this router is mounted with express.raw() in server.js so req.body is a Buffer.
// Paystack signs the raw body with HMAC-SHA512 and sends the digest in `x-paystack-signature`.
router.post('/paystack', (req, res) => {
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

  // Respond fast — Paystack retries on non-2xx, so do the heavy lifting after responding.
  res.json({ received: true });

  (async () => {
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
            sendEmail({ to: email, ...emailTemplates.orderConfirmation(order, items) }).catch(() => {});
          }
          if (phone) {
            sendSMS({ to: phone, message: smsTemplates.paid(order) }).catch(() => {});
          }
          checkAndQualifyReferral(order.id, order.user_id).catch((err) =>
            logger.error(`Referral qualify error (order ${order.id}): ${err.message}`)
          );
        }
      }
    } catch (err) {
      logger.error(`Paystack webhook handling error: ${err.message}`);
    }
  })();
});

export default router;
