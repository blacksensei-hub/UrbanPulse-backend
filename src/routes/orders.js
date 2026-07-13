import express from 'express';
import { body, validationResult } from 'express-validator';
import { query, tx } from '../db/index.js';
import { asyncHandler, badRequest, forbidden, notFound, generateOrderNumber } from '../utils/helpers.js';
import { optionalAuth, requireAuth, viewAsMiddleware, rejectViewAsWrites } from '../middleware/auth.js';
import { generateReceiptPDF } from '../utils/receipt.js';
import { getSettings } from '../utils/settingsCache.js';
import { redeemPoints } from '../utils/loyalty.js';

async function resolveCoupon(queryFn, coupon_code, { subtotal, shipping, userId }) {
  const cp = await queryFn.query(
    `SELECT id, type, value, min_order_amount, usage_limit, used_count,
            valid_from, valid_until, is_active, first_order_only,
            starts_at, buy_x, get_y
     FROM coupons WHERE UPPER(code) = UPPER($1)`,
    [coupon_code]
  );
  const cpRow = cp.rows[0];
  if (!cpRow)                throw badRequest('Invalid coupon code');
  if (!cpRow.is_active)      throw badRequest('Coupon is not active');
  if (cpRow.starts_at && new Date(cpRow.starts_at) > new Date())
                             throw badRequest('Coupon is not yet valid');
  if (cpRow.valid_from && new Date(cpRow.valid_from) > new Date())
                             throw badRequest('Coupon is not yet valid');
  if (cpRow.valid_until && new Date(cpRow.valid_until) < new Date())
                             throw badRequest('Coupon has expired');
  if (cpRow.usage_limit && cpRow.used_count >= cpRow.usage_limit)
                             throw badRequest('Coupon usage limit reached');
  if (subtotal < Number(cpRow.min_order_amount))
                             throw badRequest('Order does not meet minimum amount');
  if (cpRow.first_order_only && userId) {
    const prev = await queryFn.query(
      `SELECT id FROM orders WHERE user_id = $1 LIMIT 1`, [userId]
    );
    if (prev.rows.length > 0) throw badRequest('Coupon is valid for first orders only');
  }

  let discount = 0;
  let label = '';
  if (cpRow.type === 'percentage') {
    discount = +(subtotal * Number(cpRow.value) / 100).toFixed(2);
    label = `${cpRow.value}% off`;
  } else if (cpRow.type === 'fixed') {
    discount = Math.min(Number(cpRow.value), subtotal);
    label = `GH₵ ${Number(cpRow.value).toFixed(2)} off`;
  } else if (cpRow.type === 'free_shipping') {
    discount = shipping;
    label = 'Free shipping applied';
  }
  return { discount, couponId: cpRow.id, type: cpRow.type, value: cpRow.value, label };
}

const router = express.Router();

// POST /api/orders/preview  — validate coupon without creating an order
router.post('/preview', optionalAuth, asyncHandler(async (req, res) => {
  const { coupon_code, subtotal: rawSubtotal, shipping_method } = req.body;
  if (!coupon_code || rawSubtotal == null) throw badRequest('coupon_code and subtotal required');
  const subtotal = Number(rawSubtotal);
  const _s = await getSettings();
  const _std = Number(_s.shipping_standard_ghs ?? 30);
  const _exp = Number(_s.shipping_express_ghs ?? 80);
  const _thr = Number(_s.free_shipping_threshold_ghs ?? 1000);
  const shipping = shipping_method === 'express' ? _exp : (subtotal >= _thr ? 0 : _std);
  const result = await resolveCoupon(
    { query: (sql, p) => query(sql, p) },
    coupon_code,
    { subtotal, shipping, userId: req.user?.id ?? null }
  );
  res.json({
    valid: true,
    discount: result.discount,
    type: result.type,
    label: result.label,
    new_shipping: result.type === 'free_shipping' ? 0 : shipping,
  });
}));

// POST /api/orders  — create a pending order from current cart
router.post(
  '/',
  optionalAuth,
  ...rejectViewAsWrites,
  body('shipping_address').isObject(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { shipping_address, coupon_code, email, shipping_method, payment_method: rawPM, apply_store_credit_ghs, apply_loyalty_points } = req.body;
    const payment_method = rawPM ?? 'paystack';
    if (!['paystack', 'cod'].includes(payment_method)) throw badRequest('Invalid payment_method');
    if (payment_method === 'cod') {
      const phone = shipping_address?.phone;
      if (!phone) throw badRequest('Phone number is required for Cash on Delivery');
    }

    // Resolve cart — prefer authed user's cart, fall back to session header
    let cart;
    if (req.user) {
      const r = await query('SELECT * FROM carts WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [req.user.id]);
      cart = r.rows[0];
    } else {
      const sid = req.get('X-Session-Id');
      if (sid) {
        const r = await query('SELECT * FROM carts WHERE session_id = $1 ORDER BY id DESC LIMIT 1', [sid]);
        cart = r.rows[0];
      }
    }
    if (!cart) throw badRequest('Cart is empty');
    const cart_id = cart.id;

    const order = await tx(async (c) => {
      const items = await c.query(
        `SELECT ci.quantity, pv.id AS variant_id, pv.size, pv.color, pv.stock,
                p.id AS product_id, p.name, p.images,
                (p.price + COALESCE(pv.price_adjustment,0)) AS price,
                p.is_preorder, p.preorder_ships_at, p.preorder_limit, p.preorder_count
         FROM cart_items ci
         JOIN product_variants pv ON pv.id = ci.variant_id
         JOIN products p ON p.id = pv.product_id
         WHERE ci.cart_id = $1`,
        [cart_id]
      );
      if (!items.rows.length) throw badRequest('Cart is empty');

      const subtotal = items.rows.reduce((s, it) => s + Number(it.price) * it.quantity, 0);
      const cfg = await getSettings();
      const stdRate    = Number(cfg.shipping_standard_ghs    ?? 30);
      const expRate    = Number(cfg.shipping_express_ghs     ?? 80);
      const freeThresh = Number(cfg.free_shipping_threshold_ghs ?? 1000);
      const taxRate    = Number(cfg.tax_rate_percent         ?? 12.5) / 100;
      const shipping = shipping_method === 'express' ? expRate : (subtotal >= freeThresh ? 0 : stdRate);
      const tax = +(subtotal * taxRate).toFixed(2);

      if (payment_method === 'cod' && cfg.feature_cod === 'false') {
        throw badRequest('Cash on delivery is currently unavailable');
      }
      const hasPreorder = items.rows.some(it => it.is_preorder);
      if (hasPreorder && cfg.feature_preorders === 'false') {
        throw badRequest('Pre-orders are currently unavailable');
      }

      let discount = 0;
      let couponId = null;
      if (coupon_code) {
        const result = await resolveCoupon(c, coupon_code, { subtotal, shipping, userId: req.user?.id ?? null });
        discount = result.discount;
        couponId = result.couponId;
      }

      // Apply store credit (server-side authoritative)
      let creditApplied = 0;
      if (req.user && Number(apply_store_credit_ghs) > 0) {
        const { rows: [creditRow] } = await c.query(
          'SELECT store_credit_ghs AS bal FROM users WHERE id = $1',
          [req.user.id]
        );
        const available = Number(creditRow?.bal ?? 0);
        const maxApplicable = +(subtotal + shipping + tax - discount).toFixed(2);
        creditApplied = +Math.min(Number(apply_store_credit_ghs), available, maxApplicable).toFixed(2);
        creditApplied = Math.max(0, creditApplied);
      }

      // Apply loyalty points (server-side authoritative, applied after coupon + credit —
      // stacking precedence: coupon → store credit → points). This block is calculation-only;
      // the actual balance mutation happens via redeemPoints() after the order row exists.
      let pointsRedeemed = 0;
      let pointsCediValue = 0;
      if (req.user && Number(apply_loyalty_points) > 0 && cfg.feature_loyalty !== 'false' && cfg.feature_loyalty !== false) {
        const { rows: [loyaltyRow] } = await c.query(
          'SELECT loyalty_points AS bal FROM users WHERE id = $1',
          [req.user.id]
        );
        const pointsBalance = Number(loyaltyRow?.bal ?? 0);
        const minRedeemPoints = Number(cfg.loyalty_min_redeem_points ?? 100);
        const redeemRateGhs = Number(cfg.loyalty_redeem_rate_ghs ?? 0.1);
        const preLoyaltyTotal = +(subtotal + shipping + tax - discount - creditApplied).toFixed(2);
        const maxByTotal = Math.floor(preLoyaltyTotal / redeemRateGhs);

        pointsRedeemed = Math.min(Math.floor(Number(apply_loyalty_points)), pointsBalance, maxByTotal);
        pointsRedeemed = Math.max(0, pointsRedeemed);
        if (pointsRedeemed > 0 && pointsRedeemed < minRedeemPoints) pointsRedeemed = 0; // below minimum → redeem nothing, no error
        pointsCediValue = +(pointsRedeemed * redeemRateGhs).toFixed(2);
      }

      const total = +(subtotal + shipping + tax - discount - creditApplied - pointsCediValue).toFixed(2);
      const orderNumber = generateOrderNumber();

      const orderStatus = payment_method === 'cod' ? 'awaiting_confirmation' : 'pending';
      const o = await c.query(
        `INSERT INTO orders
           (user_id, email, order_number, subtotal, shipping_cost, tax, total, shipping_address, payment_method, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user?.id ?? null, email ?? req.user?.email ?? null,
         orderNumber, subtotal, shipping, tax, total, shipping_address,
         payment_method, orderStatus]
      );
      const orderId = o.rows[0].id;

      for (const it of items.rows) {
        if (it.is_preorder) {
          // ── Pre-order: bypass stock; check preorder_limit with row-level lock ─
          if (it.preorder_limit !== null) {
            const { rows: [p] } = await c.query(
              'SELECT preorder_count, preorder_limit FROM products WHERE id = $1 FOR UPDATE',
              [it.product_id]
            );
            if (Number(p.preorder_count) + it.quantity > Number(p.preorder_limit))
              throw badRequest(`Pre-order limit reached for "${it.name}"`);
          }
          await c.query(
            'UPDATE products SET preorder_count = preorder_count + $1 WHERE id = $2',
            [it.quantity, it.product_id]
          );
          await c.query(
            `INSERT INTO order_items
              (order_id, product_name, product_image, quantity, unit_price,
               variant_description, variant_id, is_preorder, preorder_ships_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)`,
            [orderId, it.name, it.images?.[0] ?? null, it.quantity, it.price,
             `${it.size ?? ''} / ${it.color ?? ''}`.trim(),
             it.variant_id, it.preorder_ships_at]
          );
        } else {
          // ── Normal: stock check + decrement ─────────────────────────────────
          if (it.stock < it.quantity) throw badRequest(`Out of stock: ${it.name}`);
          await c.query(
            `INSERT INTO order_items
              (order_id, product_name, product_image, quantity, unit_price,
               variant_description, variant_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [orderId, it.name, it.images?.[0] ?? null, it.quantity, it.price,
             `${it.size ?? ''} / ${it.color ?? ''}`.trim(), it.variant_id]
          );
          await c.query(
            'UPDATE product_variants SET stock = stock - $1 WHERE id = $2',
            [it.quantity, it.variant_id]
          );
        }
      }

      if (payment_method === 'cod') {
        await c.query(
          'INSERT INTO order_status_history (order_id, status, note) VALUES ($1,$2,$3)',
          [orderId, 'awaiting_confirmation', 'COD order placed — awaiting admin confirmation']
        );
      }

      if (couponId) {
        await c.query(
          'INSERT INTO order_coupons (order_id, coupon_id, discount_amount) VALUES ($1,$2,$3)',
          [orderId, couponId, discount]
        );
        await c.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [couponId]);
      }

      // Deduct store credit atomically with the order
      if (creditApplied > 0) {
        await c.query(
          'UPDATE users SET store_credit_ghs = store_credit_ghs - $1 WHERE id = $2',
          [creditApplied, req.user.id]
        );
        await c.query(
          `INSERT INTO store_credit_ledger (user_id, amount_ghs, reason, related_id)
           VALUES ($1, $2, 'spent_on_order', $3)`,
          [req.user.id, -creditApplied, orderId]
        );
      }

      // Deduct loyalty points atomically with the order. Re-validates against the freshest
      // locked balance — if it changed since the calculation above (e.g. a race with a second
      // simultaneous checkout tab), this throws and the whole order transaction rolls back.
      if (pointsRedeemed > 0) {
        await redeemPoints(c, req.user.id, pointsRedeemed, orderId);
      }

      // Clear the cart so users don't reorder by accident — but only for COD,
      // where order creation IS the commitment. For Paystack orders the cart
      // survives until the checkout session is successfully created (see
      // checkout.js), so a payment-init failure never strands the customer
      // with a placed order and an empty cart.
      if (payment_method === 'cod') {
        await c.query('DELETE FROM cart_items WHERE cart_id = $1', [cart_id]);
      }

      return o.rows[0];
    });

    const response = order.payment_method === 'cod'
      ? { ...order, awaiting_confirmation: true }
      : order;
    res.status(201).json(response);
  })
);

// GET /api/orders/user/me
router.get('/user/me', requireAuth, viewAsMiddleware, asyncHandler(async (req, res) => {
  const userId = req.viewAs?.user_id ?? req.user.id;
  const { rows } = await query(
    'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  res.json(rows);
}));

// GET /api/orders/:id/receipt.pdf — must appear before /:id to avoid route shadowing
router.get('/:id/receipt.pdf', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [order] } = await query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!order) throw notFound('Order');

  // Ownership — admin bypasses; customers must own the order
  if (order.user_id && order.user_id !== req.user.id && req.user.role !== 'admin') {
    throw forbidden('Access denied');
  }

  // Eligibility — only paid or COD-delivered orders
  const isCOD   = order.payment_method === 'cod';
  const isPaid  = order.payment_status === 'paid';
  const codDone = isCOD && (order.status === 'delivered' || isPaid);
  if (!isPaid && !codDone) {
    throw badRequest('Receipt is only available for paid orders');
  }

  const { rows: items } = await query(
    'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id',
    [order.id]
  );
  const { rows: couponRows } = await query(
    'SELECT discount_amount FROM order_coupons WHERE order_id = $1 LIMIT 1',
    [order.id]
  );
  const couponDiscount = couponRows[0] ? Number(couponRows[0].discount_amount) : 0;

  let user = null;
  if (order.user_id) {
    const { rows: [u] } = await query(
      'SELECT name, email FROM users WHERE id = $1',
      [order.user_id]
    );
    user = u ?? null;
  }

  const buffer = await generateReceiptPDF(order, items, user, { couponDiscount });

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="urbanpulse-receipt-${order.order_number}.pdf"`,
    'Content-Length': buffer.length,
  });
  res.send(buffer);
}));

// GET /api/orders/:id/history
router.get('/:id/history', optionalAuth, asyncHandler(async (req, res) => {
  const { rows: [order] } = await query('SELECT id, user_id FROM orders WHERE id = $1', [req.params.id]);
  if (!order) throw notFound('Order');
  if (req.user && order.user_id && order.user_id !== req.user.id && req.user.role !== 'admin') {
    throw notFound('Order');
  }
  const { rows } = await query(
    'SELECT id, status, note, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at ASC',
    [order.id]
  );
  res.json(rows);
}));

// GET /api/orders/:id
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) throw notFound('Order');
  if (req.user && order.user_id && order.user_id !== req.user.id && req.user.role !== 'admin') {
    throw notFound('Order');
  }
  const items = await query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);

  // No column on `orders` stores this — points are earned at payment confirmation (not order
  // creation), so both fields are 0 for an order that hasn't been paid yet, which is expected.
  const { rows: loyaltyRows } = await query(
    `SELECT delta, reason FROM loyalty_ledger
     WHERE related_id = $1 AND reason IN ('earned_purchase', 'redeemed_credit')`,
    [order.id]
  );
  const points_earned = loyaltyRows.find((r) => r.reason === 'earned_purchase')?.delta ?? 0;
  const points_redeemed = -(loyaltyRows.find((r) => r.reason === 'redeemed_credit')?.delta ?? 0);
  // Cedi-equivalent values are computed from the *current* redeem rate for display purposes only
  // (the ledger stores point deltas, not a frozen cedi value) — fine since this rate rarely changes.
  const cfg = await getSettings();
  const redeemRate = Number(cfg.loyalty_redeem_rate_ghs ?? 0.1);

  res.json({
    ...order,
    items: items.rows,
    loyalty: {
      points_earned,
      points_redeemed,
      points_earned_ghs: +(points_earned * redeemRate).toFixed(2),
      points_redeemed_ghs: +(points_redeemed * redeemRate).toFixed(2),
    },
  });
}));

export default router;
