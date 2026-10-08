// Confirming a Paystack payment. The webhook and the customer's return from
// Paystack (/api/checkout/verify) both land here, and whichever arrives
// first does the whole job: marks the order paid, writes its history,
// awards loyalty points, and sends the confirmation and referral credit.
// The second finds the order already paid and does nothing.
//
// A payment can arrive after its order was cancelled: the expiry job
// (utils/orderExpiry.js) releases orders left unpaid for 2 hours. Such an
// order is reinstated if its stock and store credit are still there, and
// otherwise the payment is refunded through Paystack.

import { tx, query } from '../db/index.js';
import { sendEmail, emailTemplates } from './email.js';
import { sendSMS, smsTemplates } from './sms.js';
import { logger } from './logger.js';
import { checkAndQualifyReferral } from './referral.js';
import { awardPointsForOrder } from './loyalty.js';
import { getSettings } from './settingsCache.js';
import { refundTransaction } from './paystackHelper.js';
import { reinstateExpiredOrder } from './refunds.js';

/** True when a charge pays the order in full, in cedis (amounts in pesewas). */
export function chargeCovers(order, charge) {
  return charge?.currency === 'GHS'
    && Number(charge?.amount) >= Math.round(Number(order.total) * 100);
}

// A reference this server issued for the order: its order number, or the
// order number with a retry suffix (see /api/checkout/session).
const referenceIsFor = (order, reference) =>
  reference === order.order_number || reference.startsWith(`${order.order_number}-R`);

/**
 * The order a successful charge is for, locked for update. Matched by the
 * stored reference; if the order has been given a newer reference since
 * (the payment page opened twice), by the order id in the charge's
 * metadata, as long as the reference is still one issued for that order.
 */
async function orderForCharge(c, reference, charge) {
  const byRef = await c.query('SELECT * FROM orders WHERE paystack_reference = $1 FOR UPDATE', [reference]);
  if (byRef.rows[0]) return byRef.rows[0];
  const orderId = Number(charge?.metadata?.order_id);
  if (!Number.isInteger(orderId)) return null;
  const byId = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  const order = byId.rows[0];
  return order && referenceIsFor(order, reference) ? order : null;
}

/**
 * Marks the order paid if `charge` (Paystack's transaction data) is a
 * successful payment of its full total. Returns the order when this call
 * marked it paid, otherwise null.
 */
export async function confirmPayment(reference, charge) {
  let toRefund = null;
  const order = await tx(async (c) => {
    const found = await orderForCharge(c, reference, charge);
    if (!found || ['paid', 'refunded', 'refunding'].includes(found.payment_status)) return null;
    if (!chargeCovers(found, charge)) {
      logger.warn('Paystack charge does not cover the order; not marking it paid', {
        orderId: found.id, reference, amount: charge?.amount, currency: charge?.currency, total: found.total,
      });
      return null;
    }
    let note = 'Payment confirmed via Paystack';
    if (found.status === 'cancelled') {
      if (!(await reinstateExpiredOrder(c, found))) {
        // Claimed for a refund while the order is locked, so the webhook and
        // the customer's return can't both refund it.
        await c.query(`UPDATE orders SET payment_status = 'refunding' WHERE id = $1`, [found.id]);
        toRefund = found;
        return null;
      }
      note = 'Paid after the order expired; its stock was still there, so it was reinstated';
    }
    const { rows } = await c.query(
      `UPDATE orders SET payment_status = 'paid', status = 'processing'
        WHERE id = $1 AND payment_status <> 'paid' RETURNING *`,
      [found.id]
    );
    const ord = rows[0];
    if (!ord) return null;
    await c.query(
      'INSERT INTO order_status_history (order_id, status, note) VALUES ($1, $2, $3)',
      [ord.id, 'paid', note]
    );
    await c.query(
      'INSERT INTO order_status_history (order_id, status, note) VALUES ($1, $2, $3)',
      [ord.id, 'processing', null]
    );
    await awardPointsForOrder(c, ord);
    return ord;
  });
  if (toRefund) await refundPayment(toRefund, reference, Number(charge.amount) / 100);
  if (order) await notifyPaid(order);
  return order;
}

/**
 * Gives a payment for a cancelled order back in full. The caller has claimed
 * it (payment_status 'refunding'). Returns true once refunded.
 *
 * If Paystack refuses, the money is still with the store, so the order is
 * marked 'refund_failed' with the amount, reference and Paystack's reason, the
 * store is emailed, and it waits in "Payments to refund" on the admin's Today
 * page: retry there, or refund the customer by hand and mark it done. A retry
 * of the webhook from Paystack tries again too. `adminId` is set when an
 * admin's retry made the attempt.
 *
 * The failure goes in the order's edit log, which only admins see, not its
 * status history: customers see that, and Paystack's reason can be about the
 * store's own account.
 */
export async function refundPayment(order, reference, amount, { adminId = null } = {}) {
  try {
    await refundTransaction(reference, amount);
  } catch (err) {
    await tx(async (c) => {
      await c.query(`UPDATE orders SET payment_status = 'refund_failed' WHERE id = $1`, [order.id]);
      await c.query(
        'INSERT INTO order_edits (order_id, field, before_value, after_value, reason, admin_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [order.id, 'refund_failed', {}, { amount, reference, error: err.message },
          adminId ? 'Retried refund failed' : 'Automatic refund failed: paid after the order was cancelled', adminId]
      );
    });
    logger.error('Refunding a payment for a cancelled order failed', { orderId: order.id, reference, amount, err: err.message });
    // An admin's retry is answered on screen; only automatic failures email.
    const staff = process.env.ADMIN_EMAIL || process.env.SMTP_FROM;
    if (staff && !adminId) {
      await sendEmail({ to: staff, ...emailTemplates.refundFailed({ order_number: order.order_number, amount, reference, error: err.message }) })
        .catch((e) => logger.error('Refund-needed staff email failed', { orderId: order.id, err: e.message }));
    }
    return false;
  }
  await tx(async (c) => {
    await c.query(`UPDATE orders SET payment_status = 'refunded' WHERE id = $1`, [order.id]);
    await c.query(
      'INSERT INTO order_status_history (order_id, status, note) VALUES ($1, $2, $3)',
      [order.id, 'refunded', adminId
        ? 'Refunded through Paystack'
        : 'Paid after the order was cancelled, with its stock gone; refunded through Paystack']
    );
    await c.query(
      'INSERT INTO order_edits (order_id, field, before_value, after_value, reason, admin_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [order.id, 'refund', { amount: 0 }, { amount },
        adminId ? 'Refund retried after the automatic refund failed' : 'Automatic refund: paid after the order was cancelled', adminId]
    );
  });
  logger.warn('Refunded a payment for a cancelled order', { orderId: order.id, reference, amount });
  const email = order.email || order.shipping_address?.email;
  if (email) {
    await sendEmail({ to: email, ...emailTemplates.refunded({ ...order, total: amount }) })
      .catch((err) => logger.error('Late-payment refund email failed', { orderId: order.id, err: err.message }));
  }
  return true;
}

// Confirmation email and SMS, and referral credit. Awaited, not left
// running: on serverless the function can stop as soon as it responds.
async function notifyPaid(order) {
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
    // Bundle saving included, or the email would show it as store credit.
    const couponDiscount = (couponRows[0] ? Number(couponRows[0].discount_amount) : 0)
      + Number(order.bundle_discount_ghs || 0);
    const cfg = await getSettings();
    const expressRateGhs = Number(cfg.shipping_express_ghs ?? 80);
    await sendEmail({ to: email, ...emailTemplates.orderConfirmation(order, items, { couponDiscount, expressRateGhs, taxRatePercent: cfg.tax_rate_percent }) })
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
