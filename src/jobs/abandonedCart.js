import { query } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { sendEmail, emailTemplates } from '../utils/email.js';

const CART_URL = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/cart`;

async function getActiveCoupon() {
  try {
    const { rows } = await query(
      `SELECT code FROM coupons
       WHERE is_active = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
         AND min_order_amount = 0
       ORDER BY created_at DESC LIMIT 1`
    );
    return rows[0]?.code ?? null;
  } catch (err) {
    logger.error({ err }, 'abandonedCartJob: getActiveCoupon query failed');
    return null;
  }
}

export async function runAbandonedCartJob() {
  const { rows: carts } = await query(
    `SELECT c.id, c.user_id, c.updated_at, u.email, u.name
     FROM carts c
     JOIN users u ON u.id = c.user_id
     WHERE c.user_id IS NOT NULL
       AND c.updated_at BETWEEN NOW() - INTERVAL '72 hours' AND NOW() - INTERVAL '3 hours'
       AND (SELECT COUNT(*) FROM cart_items WHERE cart_id = c.id) > 0
       AND c.reminder_count < 1
       AND NOT EXISTS (
         SELECT 1 FROM orders o
         WHERE o.user_id = c.user_id
           AND o.payment_status = 'paid'
           AND o.created_at > c.updated_at
       )`
  );

  if (carts.length === 0) {
    logger.info('abandonedCartJob: no qualifying carts');
    return { processed: 0, emails_sent: 0 };
  }

  const coupon = await getActiveCoupon();
  let sent = 0;

  for (const cart of carts) {
    try {
      const { rows: items } = await query(
        `SELECT ci.quantity, pv.size, pv.color, p.name, p.price, p.images
         FROM cart_items ci
         JOIN product_variants pv ON pv.id = ci.variant_id
         JOIN products p ON p.id = pv.product_id
         WHERE ci.cart_id = $1`,
        [cart.id]
      );

      if (items.length === 0) continue;

      const template = emailTemplates.abandonedCart({
        user: { name: cart.name, email: cart.email },
        items,
        coupon,
        cartUrl: CART_URL,
      });

      await sendEmail({ to: cart.email, ...template });

      await query(
        `UPDATE carts SET reminder_sent_at = NOW(), reminder_count = reminder_count + 1
         WHERE id = $1`,
        [cart.id]
      );

      sent++;
    } catch (err) {
      logger.error({ err, cartId: cart.id }, 'abandonedCartJob: failed to process cart');
    }
  }

  logger.info({ sent, total: carts.length }, 'abandonedCartJob: complete');
  return { processed: carts.length, emails_sent: sent };
}
