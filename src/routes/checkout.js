import express from 'express';
import { body, validationResult } from 'express-validator';
import { query, tx } from '../db/index.js';
import { asyncHandler, badRequest, notFound } from '../utils/helpers.js';
import { optionalAuth } from '../middleware/auth.js';
import { initializeTransaction, verifyTransaction } from '../utils/paystackHelper.js';
import { getSettings } from '../utils/settingsCache.js';
import { awardPointsForOrder } from '../utils/loyalty.js';

const router = express.Router();

// Resolve the requester's cart id (logged-in user's cart, else the guest cart
// keyed by X-Session-Id) — mirrors cart.js's resolveCart, read-only.
async function resolveCartId(req) {
  if (req.user) {
    const r = await query('SELECT id FROM carts WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [req.user.id]);
    return r.rows[0]?.id ?? null;
  }
  const sid = req.get('X-Session-Id');
  if (!sid) return null;
  const r = await query('SELECT id FROM carts WHERE session_id = $1 ORDER BY id DESC LIMIT 1', [sid]);
  return r.rows[0]?.id ?? null;
}

// POST /api/checkout/session — initialize a Paystack transaction for a pending order
router.post(
  '/session',
  optionalAuth,
  body('order_id').isInt(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());

    const { order_id, payment_method } = req.body;
    const { rows } = await query('SELECT * FROM orders WHERE id = $1', [order_id]);
    const order = rows[0];
    if (!order) throw notFound('Order');
    if (order.payment_method === 'cod') throw badRequest('COD orders do not need a Paystack session');
    if (order.payment_status === 'paid') throw badRequest('Already paid');

    const cfg = await getSettings();
    if (cfg.feature_paystack === 'false') throw badRequest('Online payments are currently unavailable');

    // First init uses the order_number as the Paystack reference (easy manual
    // correlation). Retries after a prior successful init need a fresh suffixed
    // reference — Paystack rejects re-initializing a reference it has seen.
    // Webhook/verify/refund all correlate via the stored paystack_reference
    // column, so a changed reference stays consistent end-to-end.
    const reference = order.paystack_reference
      ? `${order.order_number}-R${Date.now().toString(36)}`
      : order.order_number;
    const email = order.email || order.shipping_address?.email;
    if (!email) throw badRequest('Customer email required');

    const CHANNELS = {
      mobile_money: ['mobile_money'],
      card:         ['card', 'bank'],
    };
    const channels = CHANNELS[payment_method] ?? ['mobile_money', 'card', 'bank'];

    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';

    const data = await initializeTransaction({
      email,
      amount: order.total, // helper converts GHS → pesewas
      reference,
      // No &reference= here — Paystack appends its own ?trxref=&reference= to
      // the callback, and doubling them up produced a messy success URL.
      callback_url: `${frontend}/order-success?id=${order.id}`,
      metadata: {
        order_id: order.id,
        order_number: order.order_number,
        custom_fields: [
          { display_name: 'Order Number', variable_name: 'order_number', value: order.order_number },
        ],
      },
      channels,
    });

    await query(
      'UPDATE orders SET paystack_reference = $1 WHERE id = $2',
      [reference, order.id]
    );

    // The payment journey has genuinely started — NOW it's safe to clear the
    // cart (order creation deliberately no longer does this for Paystack, so a
    // failed init leaves the cart intact for a clean retry). No-op on retries.
    const cartId = await resolveCartId(req);
    if (cartId) await query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);

    // Frontend expects { url } — keep the field name stable.
    res.json({ url: data.authorization_url, reference: data.reference, access_code: data.access_code });
  })
);

// GET /api/checkout/verify/:reference — fallback for clients that land on the callback
// before the webhook has fired. Idempotent: just marks the order paid if Paystack confirms it.
router.get('/verify/:reference', asyncHandler(async (req, res) => {
  const data = await verifyTransaction(req.params.reference);
  if (data?.status === 'success') {
    await tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE orders
           SET payment_status = 'paid', status = 'processing'
         WHERE paystack_reference = $1
           AND payment_status <> 'paid'
         RETURNING *`,
        [req.params.reference]
      );
      const order = rows[0];
      if (order) await awardPointsForOrder(c, order);
    });
  }
  res.json({ status: data?.status, reference: data?.reference });
}));

export default router;
