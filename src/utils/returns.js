import { query } from '../db/index.js';

export async function canReturnOrder(order) {
  if (order.payment_status !== 'paid')
    return { eligible: false, reason: 'Order has not been paid' };
  if (order.status !== 'delivered')
    return { eligible: false, reason: 'Order has not been delivered yet' };

  // Use order_status_history for accurate delivery timestamp
  const { rows } = await query(
    `SELECT created_at FROM order_status_history
     WHERE order_id = $1 AND status = 'delivered'
     ORDER BY created_at DESC LIMIT 1`,
    [order.id]
  );
  const deliveredAt = new Date(rows[0]?.created_at ?? order.updated_at);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  if (deliveredAt < cutoff)
    return { eligible: false, reason: 'Return window has expired (30 days from delivery)' };

  return { eligible: true };
}
