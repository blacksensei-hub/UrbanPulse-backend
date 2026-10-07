// Money and goods going back on an order: refunds of every kind, and
// cancelling an order that was never paid.
//
// Each admin route claims its refund or cancellation in one short
// transaction that locks the order row (lockOrder), so a second click, or a
// refund of another kind at the same moment, waits and then sees the first.
// Paystack is called only after the claim is committed, never while a lock
// is held, and the claim is undone if Paystack refuses.

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
export async function returnCreditSpent(client, order, reason) {
  if (!order.user_id) return 0;
  const { rows: [spent] } = await client.query(
    `SELECT COALESCE(SUM(-amount_ghs), 0) AS amount FROM store_credit_ledger
      WHERE related_id = $1 AND user_id = $2 AND reason = 'spent_on_order'`,
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

// Gives back what placing an unpaid order took: its stock, any pre-order
// places, the store credit spent and the coupon use. The caller has the
// order locked and has just moved it to cancelled, so this runs once per
// order however many times cancel is clicked.
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
  await client.query(
    `UPDATE coupons SET used_count = GREATEST(used_count - 1, 0)
      WHERE id IN (SELECT coupon_id FROM order_coupons WHERE order_id = $1)`,
    [order.id]
  );
}
