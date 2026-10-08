// Releases Paystack orders left unpaid for 2 hours. Placing an order takes its
// stock, store credit and coupon use straight away, and a payment that's
// abandoned would otherwise hold them forever. Run every 15 minutes by the
// scheduled-jobs workflow through POST /api/cron/expire-orders.
//
// Before releasing an order it asks Paystack about the latest payment: one
// that succeeded is confirmed instead (a missed webhook), one still in
// progress is left for the next run, and if Paystack can't be reached the
// order is left alone rather than guessed at. A payment that arrives after
// the release is handled in utils/payments.js.
import { query, tx } from '../db/index.js';
import { verifyTransaction } from '../utils/paystackHelper.js';
import { confirmPayment } from '../utils/payments.js';
import { lockOrder, releaseUnpaidOrder, EXPIRED_NOTE } from '../utils/refunds.js';
import { logger } from '../utils/logger.js';

export const EXPIRY_MINUTES = 120;
const STILL_PAYING = new Set(['ongoing', 'pending', 'processing', 'queued']);
const OPEN_PAYMENT = "payment_status NOT IN ('paid', 'refunded', 'refunding')";
const OPEN_ORDER = "status NOT IN ('cancelled', 'refunded')";

// What Paystack says about a reference: its transaction, 'not-found' when the
// payment page was never used, or null when Paystack couldn't be asked.
async function paystackStatus(reference) {
  try {
    return await verifyTransaction(reference);
  } catch (err) {
    return /not found/i.test(err.message) ? 'not-found' : null;
  }
}

// At most 20 orders a run: each costs a call to Paystack, and a serverless
// function has seconds, not minutes. Every 15 minutes that's 80 an hour, and
// each order is its own transaction, so a run cut short leaves nothing half done.
export async function runOrderExpiryJob({ olderThanMinutes = EXPIRY_MINUTES, limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT id, paystack_reference FROM orders
      WHERE payment_method = 'paystack' AND ${OPEN_PAYMENT} AND ${OPEN_ORDER}
        AND created_at < LOCALTIMESTAMP - make_interval(mins => $1)
      ORDER BY created_at LIMIT $2`,
    [olderThanMinutes, limit]
  );

  const result = { checked: rows.length, expired: 0, confirmed: 0, stillPaying: 0, unchecked: 0 };
  for (const candidate of rows) {
    if (candidate.paystack_reference) {
      const charge = await paystackStatus(candidate.paystack_reference);
      if (charge === null) { result.unchecked += 1; continue; }
      if (charge.status === 'success') {
        if (await confirmPayment(candidate.paystack_reference, charge)) result.confirmed += 1;
        continue;
      }
      if (STILL_PAYING.has(charge.status)) { result.stillPaying += 1; continue; }
    }

    const expired = await tx(async (c) => {
      const order = await lockOrder(c, candidate.id);
      // Checked again under the lock: a payment may have landed meanwhile.
      if (!order || ['paid', 'refunded', 'refunding'].includes(order.payment_status)
          || ['cancelled', 'refunded'].includes(order.status)) return false;
      await c.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
      await c.query(
        'INSERT INTO order_status_history (order_id, status, note) VALUES ($1, $2, $3)',
        [order.id, 'cancelled', EXPIRED_NOTE]
      );
      await releaseUnpaidOrder(c, order);
      return true;
    });
    if (expired) result.expired += 1;
  }
  if (rows.length) logger.info(result, 'orderExpiryJob');
  return result;
}
