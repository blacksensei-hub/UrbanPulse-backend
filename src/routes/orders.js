import express from 'express';
import { body, validationResult } from 'express-validator';
import { query, tx } from '../db/index.js';
import { asyncHandler, badRequest, forbidden, notFound, generateOrderNumber } from '../utils/helpers.js';
import { optionalAuth, requireAuth, viewAsMiddleware, rejectViewAsWrites } from '../middleware/auth.js';
import { generateReceiptPDF } from '../utils/receipt.js';
import { getSettings } from '../utils/settingsCache.js';
import { redeemPoints } from '../utils/loyalty.js';
import { logger } from '../utils/logger.js';
import { shippingFor, bundleDiscount, orderTotals } from '../utils/pricing.js';
import { lookupLimiter } from '../utils/rateLimiter.js';

async function resolveCoupon(queryFn, coupon_code, { subtotal, shipping, userId, email }) {
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
  if (subtotal < Number(cpRow.min_order_amount)) {
    const min = Number(cpRow.min_order_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    throw badRequest(`This code needs an order of GH₵ ${min} or more.`);
  }
  // An earlier order is one that went through: paid (or since refunded), or
  // cash on delivery not cancelled. A payment abandoned at Paystack doesn't
  // count. Guests are matched by email, as are customers who once ordered
  // as a guest, so a first-order coupon can't be reused by staying signed out.
  if (cpRow.first_order_only && (userId || email)) {
    const prev = await queryFn.query(
      `SELECT id FROM orders
        WHERE (user_id = $1 OR LOWER(email) = LOWER($2))
          AND (payment_status IN ('paid', 'refunded')
               OR (payment_method = 'cod' AND status <> 'cancelled'))
        LIMIT 1`,
      [userId ?? null, email ?? null]
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

const featureDisabled = () => Object.assign(new Error('This feature is currently disabled'), { status: 503 });

const router = express.Router();

// POST /api/orders/preview  — validate coupon without creating an order
router.post('/preview', optionalAuth, asyncHandler(async (req, res) => {
  const { coupon_code, subtotal: rawSubtotal, shipping_method, region } = req.body;
  if (!coupon_code || rawSubtotal == null) throw badRequest('coupon_code and subtotal required');
  const subtotal = Number(rawSubtotal);
  const shipping = shippingFor({ subtotal, method: shipping_method, region, settings: await getSettings() });
  const result = await resolveCoupon(
    { query: (sql, p) => query(sql, p) },
    coupon_code,
    { subtotal, shipping, userId: req.user?.id ?? null, email: req.user?.email ?? null }
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
      // Delivery by region (utils/pricing.js); identical to the old flat
      // rule while region pricing is off.
      const shipping = shippingFor({ subtotal, method: shipping_method, region: shipping_address?.state, settings: cfg });
      // Bundle saving, applied before coupon/credit/points and recorded on
      // the order so receipts and emails show it as a discount.
      const bundle = bundleDiscount(items.rows, cfg);

      // site_settings.value is jsonb — a stored false round-trips as a native
      // boolean, not the string 'false', so both forms must be checked (see
      // the feature_loyalty check below, and requireFeature() in settingsCache.js).
      if (payment_method === 'cod' && (cfg.feature_cod === 'false' || cfg.feature_cod === false)) {
        throw featureDisabled();
      }
      const hasPreorder = items.rows.some(it => it.is_preorder);
      if (hasPreorder && (cfg.feature_preorders === 'false' || cfg.feature_preorders === false)) {
        throw featureDisabled();
      }

      let discount = 0;
      let couponId = null;
      if (coupon_code) {
        const result = await resolveCoupon(c, coupon_code, {
          subtotal, shipping, userId: req.user?.id ?? null, email: email ?? req.user?.email ?? null,
        });
        discount = result.discount;
        couponId = result.couponId;
      }

      // Store credit and loyalty points are only a signed-in customer's, read
      // fresh here. Tax, credit, points and the total come from orderTotals in
      // utils/pricing.js, the same function the checkout page shows, applied
      // coupon → store credit → points. Points are only calculated here; the
      // balance changes via redeemPoints() once the order row exists.
      let creditAvailable = 0;
      if (req.user && Number(apply_store_credit_ghs) > 0) {
        const { rows: [creditRow] } = await c.query(
          'SELECT store_credit_ghs AS bal FROM users WHERE id = $1',
          [req.user.id]
        );
        creditAvailable = Number(creditRow?.bal ?? 0);
      }
      const loyaltyOn = Boolean(req.user) && Number(apply_loyalty_points) > 0
        && cfg.feature_loyalty !== 'false' && cfg.feature_loyalty !== false;
      let pointsBalance = 0;
      if (loyaltyOn) {
        const { rows: [loyaltyRow] } = await c.query(
          'SELECT loyalty_points AS bal FROM users WHERE id = $1',
          [req.user.id]
        );
        pointsBalance = Number(loyaltyRow?.bal ?? 0);
      }
      const totals = orderTotals({
        subtotal, shipping,
        bundleDiscount: bundle.discount,
        couponDiscount: discount,
        taxRatePercent: cfg.tax_rate_percent ?? 12.5,
        creditRequested: creditAvailable > 0 ? apply_store_credit_ghs : 0,
        creditAvailable,
        pointsRequested: loyaltyOn ? apply_loyalty_points : 0,
        pointsBalance,
        minRedeemPoints: cfg.loyalty_min_redeem_points ?? 100,
        redeemRateGhs: cfg.loyalty_redeem_rate_ghs ?? 0.1,
      });
      const { tax, credit: creditApplied, points: pointsRedeemed, total } = totals;
      const orderNumber = generateOrderNumber();

      const orderStatus = payment_method === 'cod' ? 'awaiting_confirmation' : 'pending';
      const baseCols = [req.user?.id ?? null, email ?? req.user?.email ?? null,
         orderNumber, subtotal, shipping, tax, total, shipping_address,
         payment_method, orderStatus];
      // The bundle columns are only written when a bundle applied, so an
      // order never depends on them while bundles are unused.
      const o = bundle.discount > 0
        ? await c.query(
          `INSERT INTO orders
             (user_id, email, order_number, subtotal, shipping_cost, tax, total, shipping_address, payment_method, status,
              bundle_discount_ghs, bundle_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [...baseCols, bundle.discount, bundle.note])
        : await c.query(
          `INSERT INTO orders
             (user_id, email, order_number, subtotal, shipping_cost, tax, total, shipping_address, payment_method, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          baseCols);
      const orderId = o.rows[0].id;

      // Auto-save this shipping address to the customer's address book, deduped on
      // line1+city+phone so re-using the same address across orders doesn't pile up
      // duplicate rows. Guest checkouts (no req.user) have no address book to write to.
      // This is a side effect of order creation, not part of it — wrapped in its own
      // SAVEPOINT so a failure here (e.g. the addresses table missing) can be rolled back
      // in isolation and logged without poisoning the surrounding order transaction. A
      // plain try/catch would NOT be enough: once a statement inside a Postgres transaction
      // errors, every later statement on that same connection fails too ("current
      // transaction is aborted") until a ROLLBACK — a SAVEPOINT is the only way to recover
      // and let order creation continue normally after this fails.
      if (req.user && shipping_address?.line1) {
        await c.query('SAVEPOINT address_save');
        try {
          const { rows: existing } = await c.query(
            `SELECT id FROM addresses
              WHERE user_id = $1 AND lower(line1) = lower($2)
                AND lower(COALESCE(city,'')) = lower(COALESCE($3,''))
                AND lower(COALESCE(phone,'')) = lower(COALESCE($4,''))
              LIMIT 1`,
            [req.user.id, shipping_address.line1,
             shipping_address.city ?? null, shipping_address.phone ?? null]
          );
          if (!existing[0]) {
            const { rows: [{ count }] } = await c.query(
              'SELECT COUNT(*)::int AS count FROM addresses WHERE user_id = $1',
              [req.user.id]
            );
            await c.query(
              `INSERT INTO addresses (user_id, label, name, line1, line2, city, state, zip, country, phone, is_default)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [req.user.id, shipping_address.label ?? 'Home', shipping_address.name ?? '', shipping_address.line1,
               shipping_address.line2 ?? null, shipping_address.city ?? null,
               shipping_address.state ?? null, shipping_address.zip ?? null,
               shipping_address.country ?? 'Ghana', shipping_address.phone ?? null, count === 0]
            );
          }
        } catch (err) {
          await c.query('ROLLBACK TO SAVEPOINT address_save');
          logger.error('Address-book save failed (order still proceeds)', { userId: req.user.id, err: err.message });
        }
      }

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
          // Taken in one conditional update: two orders for the last unit
          // can't both pass a check made on a stock figure read earlier.
          const took = await c.query(
            'UPDATE product_variants SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING stock',
            [it.quantity, it.variant_id]
          );
          if (!took.rows.length) throw badRequest(`Out of stock: ${it.name}`);
          await c.query(
            `INSERT INTO order_items
              (order_id, product_name, product_image, quantity, unit_price,
               variant_description, variant_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [orderId, it.name, it.images?.[0] ?? null, it.quantity, it.price,
             `${it.size ?? ''} / ${it.color ?? ''}`.trim(), it.variant_id]
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
        // Counted in one conditional update, so two orders can't both take
        // a coupon's last use. (A limit of 0 means no limit, as above.)
        const counted = await c.query(
          `UPDATE coupons SET used_count = used_count + 1
            WHERE id = $1 AND (usage_limit IS NULL OR usage_limit = 0 OR used_count < usage_limit)
            RETURNING id`,
          [couponId]
        );
        if (!counted.rows.length) throw badRequest('Coupon usage limit reached');
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

// POST /api/orders/track: order status without an account.
// Needs the order number AND the email or phone used on the order, and is
// rate-limited, so knowing (or guessing) an order number alone reveals
// nothing. Returns status, timeline and items; never the address or payment.
const lastDigits = (v) => String(v || '').replace(/\D/g, '').slice(-9);
router.post('/track', lookupLimiter, asyncHandler(async (req, res) => {
  const number = String(req.body?.order_number ?? '').trim().toUpperCase();
  const contact = String(req.body?.contact ?? '').trim().toLowerCase();
  if (!number || !contact) throw badRequest('Enter your order number and the email or phone you ordered with.');
  const notFoundMsg = "We couldn't find an order with those details. Check the order number and the email or phone you used.";

  const { rows: [o] } = await query(
    `SELECT o.id, o.order_number, o.status, o.created_at, o.email, o.shipping_address,
            o.tracking_number, o.tracking_url, o.payment_method, u.email AS user_email
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
      WHERE UPPER(o.order_number) = $1`,
    [number],
  );
  const addr = typeof o?.shipping_address === 'string' ? JSON.parse(o.shipping_address) : o?.shipping_address;
  const matches = o && (contact.includes('@')
    ? [o.email, o.user_email].some((e) => e && e.toLowerCase() === contact)
    : lastDigits(contact).length === 9 && lastDigits(addr?.phone) === lastDigits(contact));
  if (!matches) return res.status(404).json({ error: notFoundMsg });

  const [{ rows: items }, { rows: history }] = await Promise.all([
    query(`SELECT product_name, product_image, quantity, variant_description FROM order_items WHERE order_id = $1 ORDER BY id`, [o.id]),
    query(`SELECT status, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at, id`, [o.id]),
  ]);
  res.json({
    order_number: o.order_number,
    status: o.status,
    placed_at: o.created_at,
    city: addr?.city || null,
    region: addr?.state || null,
    payment_method: o.payment_method,
    tracking_number: o.tracking_number || null,
    tracking_url: o.tracking_url || null,
    items,
    history,
  });
}));

// GET /api/orders/user/me
router.get('/user/me', requireAuth, viewAsMiddleware, asyncHandler(async (req, res) => {
  const userId = req.viewAs?.user_id ?? req.user.id;
  const { rows } = await query(
    // eligible_for_return mirrors utils/returns.js's canReturnOrder — computed here so the
    // Orders list can show/hide the Return button without a nonexistent orders.updated_at
    // column (there is none; delivery time only exists in order_status_history).
    `SELECT o.*,
            (
              o.payment_status = 'paid' AND o.status = 'delivered' AND
              COALESCE(
                (SELECT osh.created_at FROM order_status_history osh
                  WHERE osh.order_id = o.id AND osh.status = 'delivered'
                  ORDER BY osh.created_at DESC LIMIT 1),
                o.created_at
              ) >= NOW() - INTERVAL '30 days'
            ) AS eligible_for_return
       FROM orders o
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC`,
    [userId]
  );
  res.json(rows);
}));

// GET /api/orders/:id/receipt.pdf — must appear before /:id to avoid route shadowing
router.get('/:id/receipt.pdf', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [order] } = await query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!order) throw notFound("We couldn't find that order.");

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
  const couponDiscount = (couponRows[0] ? Number(couponRows[0].discount_amount) : 0)
    + Number(order.bundle_discount_ghs || 0);

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
  if (!order) throw notFound("We couldn't find that order.");
  if (req.user && order.user_id && order.user_id !== req.user.id && req.user.role !== 'admin') {
    throw notFound("We couldn't find that order.");
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
  if (!order) throw notFound("We couldn't find that order.");
  if (req.user && order.user_id && order.user_id !== req.user.id && req.user.role !== 'admin') {
    throw notFound("We couldn't find that order.");
  }
  // Joined through product_variants since order_items only stores variant_id — needed so the
  // customer-facing "write a review" action on a delivered order (Account.jsx) knows which
  // product/slug each line item is for and whether this user has already reviewed it.
  const items = await query(
    `SELECT oi.*, p.id AS product_id, p.slug AS product_slug,
            EXISTS(
              SELECT 1 FROM reviews r WHERE r.user_id = $2 AND r.product_id = p.id
            ) AS already_reviewed
       FROM order_items oi
       LEFT JOIN product_variants pv ON pv.id = oi.variant_id
       LEFT JOIN products p ON p.id = pv.product_id
      WHERE oi.order_id = $1`,
    [order.id, req.user?.id ?? null]
  );

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
