// Money and goods going back on an order: refunds of every kind, and
// cancelling an order that was never paid.
//
// Each admin route claims its refund or cancellation in one short
// transaction that locks the order row (lockOrder), so a second click, or a
// refund of another kind at the same moment, waits and then sees the first.
// Paystack is called only after the claim is committed, never while a lock
// is held, and the claim is undone if Paystack refuses.
//
// Store credit and loyalty points spent on an order go back when the order
// is cancelled unpaid or refunded in full, never on a partial refund. What
// goes back is what's still outstanding (spent, less anything already
// returned), so an order that expired, was reinstated by a late payment and
// was then refunded returns its credit and points once.

import { getSettings } from './settingsCache.js';

// The order row, locked until the caller's transaction ends.
export async function lockOrder(client, orderId) {
  const { rows: [order] } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  return order;
}

// What has been given back on an order so far, by any route: return refunds
// (to card or store credit), manual refunds and a full refund. Every cap
// counts all of them, so together they never come to more than was paid.
export async function refundedSoFar(client, orderId) {
  const { rows: [r] } = await client.query(
    `SELECT COALESCE((SELECT SUM(refund_amount_ghs) FROM returns
                       WHERE order_id = $1 AND status = 'refunded'), 0)
          + COALESCE((SELECT SUM((after_value->>'amount')::numeric) FROM order_edits
                       WHERE order_id = $1 AND field IN ('manual_refund', 'refund')), 0) AS total`,
    [orderId]
  );
  return Number(r.total);
}

// Pre-order places the order took go back to the product.
export async function rollbackPreorderCount(client, orderId) {
  const { rows } = await client.query(
    `SELECT oi.quantity, pv.product_id
     FROM order_items oi
     JOIN product_variants pv ON pv.id = oi.variant_id
     WHERE oi.order_id = $1 AND oi.is_preorder = true`,
    [orderId]
  );
  for (const r of rows) {
    await client.query(
      'UPDATE products SET preorder_count = GREATEST(0, preorder_count - $1) WHERE id = $2',
      [r.quantity, r.product_id]
    );
  }
}

// Store credit the customer spent on the order goes back to their balance.
// Outstanding = spent ('spent_on_order', negative) less what a cancellation
// already gave back ('order_cancelled', positive).
export async function returnCreditSpent(client, order, reason) {
  if (!order.user_id) return 0;
  const { rows: [spent] } = await client.query(
    `SELECT COALESCE(SUM(-amount_ghs), 0) AS amount FROM store_credit_ledger
      WHERE related_id = $1 AND user_id = $2 AND reason IN ('spent_on_order', 'order_cancelled')`,
    [order.id, order.user_id]
  );
  const amount = Number(spent.amount);
  if (amount <= 0) return 0;
  await client.query(
    'UPDATE users SET store_credit_ghs = store_credit_ghs + $1 WHERE id = $2',
    [amount, order.user_id]
  );
  await client.query(
    `INSERT INTO store_credit_ledger (user_id, amount_ghs, reason, related_id)
     VALUES ($1, $2, $3, $4)`,
    [order.user_id, amount, reason, order.id]
  );
  return amount;
}

// Loyalty points redeemed on the order go back to the customer as a fresh
// batch that expires like newly earned points (old ones may have lapsed in the
// meantime). Outstanding = redeemed ('redeemed_credit', negative) less any
// already returned ('points_returned', positive). Lifetime points and tier are
// untouched: redeeming never lowered them.
export async function returnPointsRedeemed(client, order) {
  if (!order.user_id) return 0;
  const { rows: [r] } = await client.query(
    `SELECT COALESCE(SUM(-delta), 0)::int AS points FROM loyalty_ledger
      WHERE related_id = $1 AND user_id = $2 AND reason IN ('redeemed_credit', 'points_returned')`,
    [order.id, order.user_id]
  );
  if (r.points <= 0) return 0;
  const cfg = await getSettings();
  const expireDays = Number(cfg.loyalty_points_expire_days ?? 365);
  await client.query('UPDATE users SET loyalty_points = loyalty_points + $1 WHERE id = $2', [r.points, order.user_id]);
  await client.query(
    `INSERT INTO loyalty_ledger (user_id, delta, reason, related_id, expires_at)
     VALUES ($1, $2, 'points_returned', $3, NOW() + ($4 || ' days')::interval)`,
    [order.user_id, r.points, order.id, expireDays]
  );
  return r.points;
}

// The history note an order gets when the expiry job (utils/orderExpiry.js)
// releases it; a payment that arrives afterwards looks for it.
export const EXPIRED_NOTE = 'Not paid within 2 hours: stock, store credit and coupon released';

// Gives back what placing an unpaid order took: its stock, any pre-order
// places, the store credit and loyalty points spent, and the coupon use. The
// caller has the order locked and has just moved it to cancelled, so this
// runs once per order however many times cancel is clicked.
export async function releaseUnpaidOrder(client, order) {
  const { rows: items } = await client.query(
    'SELECT variant_id, quantity, is_preorder FROM order_items WHERE order_id = $1',
    [order.id]
  );
  for (const item of items) {
    if (item.is_preorder || !item.variant_id) continue;
    await client.query(
      'UPDATE product_variants SET stock = stock + $1 WHERE id = $2',
      [item.quantity, item.variant_id]
    );
  }
  await rollbackPreorderCount(client, order.id);
  await returnCreditSpent(client, order, 'order_cancelled');
  await returnPointsRedeemed(client, order);
  await client.query(
    `UPDATE coupons SET used_count = GREATEST(used_count - 1, 0)
      WHERE id IN (SELECT coupon_id FROM order_coupons WHERE order_id = $1)`,
    [order.id]
  );
}

class CannotReinstate extends Error {}

// The reverse of releaseUnpaidOrder, for a payment that arrives after the
// expiry job released the order: takes its stock, pre-order places and store
// credit again and counts the coupon use. All or nothing: returns false, with
// nothing changed, if any of it is no longer there, or if the order was
// cancelled for another reason (an admin's cancellation is never undone by a
// payment). The caller has the order locked.
export async function reinstateExpiredOrder(client, order) {
  const { rows: [last] } = await client.query(
    `SELECT note FROM order_status_history WHERE order_id = $1 AND status = 'cancelled' ORDER BY id DESC LIMIT 1`,
    [order.id]
  );
  if (last?.note !== EXPIRED_NOTE) return false;

  await client.query('SAVEPOINT reinstate');
  try {
    const { rows: items } = await client.query(
      `SELECT oi.variant_id, oi.quantity, oi.is_preorder, pv.product_id
         FROM order_items oi LEFT JOIN product_variants pv ON pv.id = oi.variant_id
        WHERE oi.order_id = $1`,
      [order.id]
    );
    for (const item of items) {
      if (!item.variant_id) continue;
      if (item.is_preorder) {
        const took = await client.query(
          `UPDATE products SET preorder_count = preorder_count + $1
            WHERE id = $2 AND (preorder_limit IS NULL OR preorder_count + $1 <= preorder_limit) RETURNING id`,
          [item.quantity, item.product_id]
        );
        if (!took.rows.length) throw new CannotReinstate('pre-order limit reached');
      } else {
        const took = await client.query(
          'UPDATE product_variants SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING id',
          [item.quantity, item.variant_id]
        );
        if (!took.rows.length) throw new CannotReinstate('out of stock');
      }
    }

    // The credit the expiry gave back is spent on the order again.
    if (order.user_id) {
      const { rows: [given] } = await client.query(
        `SELECT COALESCE(SUM(amount_ghs), 0) AS amount FROM store_credit_ledger
          WHERE related_id = $1 AND user_id = $2 AND reason = 'order_cancelled'`,
        [order.id, order.user_id]
      );
      const amount = Number(given.amount);
      if (amount > 0) {
        const took = await client.query(
          'UPDATE users SET store_credit_ghs = store_credit_ghs - $1 WHERE id = $2 AND store_credit_ghs >= $1 RETURNING id',
          [amount, order.user_id]
        );
        if (!took.rows.length) throw new CannotReinstate('store credit already spent');
        await client.query(
          `INSERT INTO store_credit_ledger (user_id, amount_ghs, reason, related_id) VALUES ($1, $2, 'spent_on_order', $3)`,
          [order.user_id, -amount, order.id]
        );
      }

      // And so are the points it gave back.
      const { rows: [back] } = await client.query(
        `SELECT COALESCE(SUM(delta), 0)::int AS points FROM loyalty_ledger
          WHERE related_id = $1 AND user_id = $2 AND reason = 'points_returned'`,
        [order.id, order.user_id]
      );
      if (back.points > 0) {
        const took = await client.query(
          'UPDATE users SET loyalty_points = loyalty_points - $1 WHERE id = $2 AND loyalty_points >= $1 RETURNING id',
          [back.points, order.user_id]
        );
        if (!took.rows.length) throw new CannotReinstate('loyalty points already spent');
        await client.query(
          `INSERT INTO loyalty_ledger (user_id, delta, reason, related_id) VALUES ($1, $2, 'redeemed_credit', $3)`,
          [order.user_id, -back.points, order.id]
        );
      }
    }

    // The coupon was valid when the order was placed, so its use counts
    // again even if the coupon has since run out.
    await client.query(
      'UPDATE coupons SET used_count = used_count + 1 WHERE id IN (SELECT coupon_id FROM order_coupons WHERE order_id = $1)',
      [order.id]
    );
    await client.query('RELEASE SAVEPOINT reinstate');
    return true;
  } catch (err) {
    if (!(err instanceof CannotReinstate)) throw err;
    await client.query('ROLLBACK TO SAVEPOINT reinstate');
    return false;
  }
}
