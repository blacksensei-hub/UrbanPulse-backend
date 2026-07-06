import express from 'express';
import slugify from 'slugify';
import multer from 'multer';
import { parse as parseCsv } from 'csv-parse/sync';
import { body, validationResult } from 'express-validator';
import { query, tx } from '../db/index.js';
import jwt from 'jsonwebtoken';
import { asyncHandler, badRequest, notFound, forbidden } from '../utils/helpers.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { adminLimiter } from '../utils/rateLimiter.js';
import { logAdminAction } from '../utils/adminLog.js';
import { sendEmail, emailTemplates } from '../utils/email.js';
import { sendSMS, smsTemplates } from '../utils/sms.js';
import { refundTransaction } from '../utils/paystackHelper.js';
import { checkAndQualifyReferral } from '../utils/referral.js';
import { canReturnOrder } from '../utils/returns.js';
import { buildRMANumber } from '../utils/helpers.js';
import { renderTemplate } from '../utils/templateRenderer.js';
import crypto from 'crypto';
import { getSettings, invalidateSettings } from '../utils/settingsCache.js';
import { runAbandonedCartJob } from '../jobs/abandonedCart.js';
import { runLoyaltyExpireJob } from '../jobs/loyaltyExpire.js';
import { awardPointsForOrder, clawbackPointsForOrder } from '../utils/loyalty.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = express.Router();
router.use(adminLimiter, requireAuth, requireAdmin);

const jobLastRun = new Map();
function checkJobCooldown(jobId) {
  const last = jobLastRun.get(jobId) ?? 0;
  if (Date.now() - last < 60_000) throw badRequest('Job triggered too recently — wait 1 minute');
  jobLastRun.set(jobId, Date.now());
}

// Rolls back product.preorder_count for preorder items in an order; safe to call in any tx
async function rollbackPreorderCount(client, orderId) {
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

// ───────── Dashboard ─────────
router.get('/dashboard/stats', asyncHandler(async (_req, res) => {
  const [revenue30, prevRevenue30, orders30, prevOrders30, users, products, abandonedCartsResult] = await Promise.all([
    query(`SELECT COALESCE(SUM(total),0)::float AS v FROM orders
             WHERE payment_status='paid' AND created_at >= NOW() - INTERVAL '30 days'`),
    query(`SELECT COALESCE(SUM(total),0)::float AS v FROM orders
             WHERE payment_status='paid'
               AND created_at >= NOW() - INTERVAL '60 days'
               AND created_at <  NOW() - INTERVAL '30 days'`),
    query(`SELECT COUNT(*)::int AS v FROM orders WHERE created_at >= NOW() - INTERVAL '30 days'`),
    query(`SELECT COUNT(*)::int AS v FROM orders
             WHERE created_at >= NOW() - INTERVAL '60 days'
               AND created_at <  NOW() - INTERVAL '30 days'`),
    query(`SELECT COUNT(*)::int AS v FROM users WHERE role='customer'`),
    query(`SELECT COUNT(*)::int AS v FROM products`),
    query(`SELECT COUNT(*)::int AS v FROM carts c
             WHERE c.user_id IS NOT NULL
               AND c.updated_at BETWEEN NOW() - INTERVAL '72 hours' AND NOW() - INTERVAL '3 hours'
               AND (SELECT COUNT(*) FROM cart_items WHERE cart_id = c.id) > 0
               AND NOT EXISTS (
                 SELECT 1 FROM orders o
                 WHERE o.user_id = c.user_id
                   AND o.payment_status = 'paid'
                   AND o.created_at > c.updated_at
               )`),
  ]);
  const pct = (curr, prev) => {
    if (!prev) return curr ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 100);
  };
  res.json({
    revenue: revenue30.rows[0].v,
    revenueDelta: pct(revenue30.rows[0].v, prevRevenue30.rows[0].v),
    orders: orders30.rows[0].v,
    ordersDelta: pct(orders30.rows[0].v, prevOrders30.rows[0].v),
    customers: users.rows[0].v,
    products: products.rows[0].v,
    abandonedCarts: abandonedCartsResult.rows[0].v,
  });
}));

router.get('/dashboard/recent-orders', asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT o.id, o.order_number, o.total, o.status, o.payment_status, o.created_at,
            COALESCE(u.email, o.email) AS customer_email, u.name AS user_name
     FROM orders o LEFT JOIN users u ON u.id = o.user_id
     ORDER BY o.created_at DESC LIMIT 10`
  );
  res.json(rows);
}));

router.get('/dashboard/low-stock', asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT pv.id, pv.sku, pv.size, pv.color, pv.stock, p.name AS product_name, p.slug
     FROM product_variants pv JOIN products p ON p.id = pv.product_id
     WHERE pv.stock <= 5 ORDER BY pv.stock ASC LIMIT 20`
  );
  res.json(rows);
}));

// ───────── Image Upload ─────────
router.post('/upload', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file provided');
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw badRequest('Cloudinary not configured — use URL entry instead');
  }
  const { v2: cloudinary } = await import('cloudinary');
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
  });
  const result = await new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder: 'urbanpulse', resource_type: 'image' }, (err, r) =>
        err ? reject(err) : resolve(r)
      )
      .end(req.file.buffer);
  });
  res.json({ secure_url: result.secure_url });
}));

// ───────── Products ─────────
router.get('/products', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const search = req.query.q || req.query.search;
  const params = [];
  let where = '';
  if (search) { params.push(`%${search}%`); where = `WHERE name ILIKE $1 OR slug ILIKE $1`; }
  const total = (await query(`SELECT COUNT(*)::int FROM products ${where}`, params)).rows[0].count;
  params.push(limit); params.push(offset);
  const { rows } = await query(
    `SELECT id, slug, name, price, compare_at_price, category, images, rating, is_active, created_at,
            (SELECT COALESCE(SUM(stock),0) FROM product_variants WHERE product_id = products.id) AS total_stock
     FROM products ${where} ORDER BY created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
    params
  );
  res.json({ items: rows, data: rows, total, page, limit });
}));

router.get('/products/:id(\\d+)', asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM products WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Not found' });
  const variants = (await query(
    `SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id`, [req.params.id]
  )).rows;
  res.json({ ...rows[0], variants });
}));

router.post(
  '/products',
  body('name').isString().trim().isLength({ min: 1 }),
  body('price').isFloat({ min: 0 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const p = req.body;
    const slug = p.slug || slugify(p.name, { lower: true, strict: true });
    if (p.is_preorder && p.preorder_ships_at && new Date(p.preorder_ships_at) <= new Date())
      throw badRequest('preorder_ships_at must be a future date');
    const { rows } = await query(
      `INSERT INTO products
         (slug,name,description,price,compare_at_price,images,category,tags,is_active,
          is_preorder,preorder_ships_at,preorder_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [slug, p.name, p.description ?? '', p.price, p.compare_at_price ?? null,
       p.images ?? [], p.category ?? null, p.tags ?? [], p.is_active ?? true,
       p.is_preorder ?? false, p.preorder_ships_at ?? null, p.preorder_limit ?? null]
    );
    const product = rows[0];
    if (Array.isArray(p.variants) && p.variants.length) {
      for (const v of p.variants) {
        await query(
          `INSERT INTO product_variants (product_id,size,color,sku,stock,price_adjustment)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [product.id, v.size || null, v.color || null, v.sku || null, Number(v.stock) || 0, Number(v.price_adjustment) || 0]
        );
      }
    }
    await logAdminAction(req.user.id, 'product.create', { id: product.id }, req.ip);
    res.status(201).json(product);
  })
);

router.put('/products/:id', asyncHandler(async (req, res) => {
  const p = req.body;
  if (p.is_preorder && p.preorder_ships_at && new Date(p.preorder_ships_at) <= new Date())
    throw badRequest('preorder_ships_at must be a future date');
  const { rows } = await query(
    `UPDATE products SET
      name = COALESCE($1,name),
      description = COALESCE($2,description),
      price = COALESCE($3,price),
      compare_at_price = $4,
      images = COALESCE($5,images),
      category = COALESCE($6,category),
      tags = COALESCE($7,tags),
      is_active = COALESCE($8,is_active),
      slug = COALESCE($9,slug),
      is_preorder = COALESCE($10,is_preorder),
      preorder_ships_at = $11,
      preorder_limit = $12,
      updated_at = NOW()
     WHERE id = $13 RETURNING *`,
    [p.name ?? null, p.description ?? null, p.price ?? null, p.compare_at_price ?? null,
     p.images ?? null, p.category ?? null, p.tags ?? null, p.is_active ?? null, p.slug ?? null,
     p.is_preorder ?? null, p.preorder_ships_at ?? null, p.preorder_limit ?? null, req.params.id]
  );
  if (!rows[0]) throw notFound();
  // Replace variants if provided
  if (Array.isArray(p.variants)) {
    const existing = (await query('SELECT id FROM product_variants WHERE product_id = $1', [req.params.id])).rows;
    const incomingIds = new Set(p.variants.filter(v => v.id).map(v => v.id));
    for (const e of existing) {
      if (!incomingIds.has(e.id)) {
        await query('DELETE FROM product_variants WHERE id = $1', [e.id]);
      }
    }
    for (const v of p.variants) {
      if (v.id) {
        await query(
          `UPDATE product_variants
              SET size = $1, color = $2, sku = $3, stock = $4, price_adjustment = $5
            WHERE id = $6 AND product_id = $7`,
          [v.size || null, v.color || null, v.sku || null, Number(v.stock) || 0, Number(v.price_adjustment) || 0, v.id, req.params.id]
        );
      } else if (v.size || v.color || v.sku) {
        await query(
          `INSERT INTO product_variants (product_id,size,color,sku,stock,price_adjustment)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id, v.size || null, v.color || null, v.sku || null, Number(v.stock) || 0, Number(v.price_adjustment) || 0]
        );
      }
    }
  }
  await logAdminAction(req.user.id, 'product.update', { id: rows[0].id }, req.ip);
  res.json(rows[0]);
}));

router.delete('/products/:id', asyncHandler(async (req, res) => {
  await query('DELETE FROM products WHERE id = $1', [req.params.id]);
  await logAdminAction(req.user.id, 'product.delete', { id: Number(req.params.id) }, req.ip);
  res.json({ ok: true });
}));

router.post('/products/:id/variants', asyncHandler(async (req, res) => {
  const { size, color, sku, stock } = req.body;
  const { rows } = await query(
    `INSERT INTO product_variants (product_id,size,color,sku,stock) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.id, size, color, sku, stock ?? 0]
  );
  res.status(201).json(rows[0]);
}));

router.put('/variants/:id', asyncHandler(async (req, res) => {
  const { size, color, sku, stock } = req.body;
  const { rows } = await query(
    `UPDATE product_variants SET
      size=COALESCE($1,size), color=COALESCE($2,color),
      sku=COALESCE($3,sku), stock=COALESCE($4,stock)
     WHERE id=$5 RETURNING *`,
    [size ?? null, color ?? null, sku ?? null, stock ?? null, req.params.id]
  );
  if (!rows[0]) throw notFound();
  res.json(rows[0]);
}));

router.delete('/variants/:id', asyncHandler(async (req, res) => {
  await query('DELETE FROM product_variants WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// CSV import
router.post('/products/import', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file provided');

  const records = parseCsv(req.file.buffer.toString('utf8'), {
    columns: true, skip_empty_lines: true, trim: true,
  });

  let created = 0, updated = 0;
  const skipped = [];

  const bySlug = {};
  for (const r of records) {
    if (!r.slug && !r.name) {
      skipped.push({ row: JSON.stringify(r), reason: 'Missing slug and name' });
      continue;
    }
    const key = r.slug || slugify(r.name, { lower: true, strict: true });
    if (!bySlug[key]) bySlug[key] = { meta: r, variants: [] };
    if (r.sku || r.size || r.color) bySlug[key].variants.push(r);
  }

  for (const [slug, { meta, variants }] of Object.entries(bySlug)) {
    try {
      const { rows } = await query(
        `INSERT INTO products (slug, name, description, price, category, images, tags, is_active)
         VALUES ($1,$2,'',$3,$4,'{}','{}',true)
         ON CONFLICT (slug) DO UPDATE SET
           name       = EXCLUDED.name,
           price      = EXCLUDED.price,
           category   = EXCLUDED.category,
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS inserted`,
        [slug, meta.name || slug, parseFloat(meta.price) || 0, meta.category || null]
      );
      const productId = rows[0].id;
      rows[0].inserted ? created++ : updated++;

      for (const v of variants) {
        if (v.sku) {
          const ex = await query('SELECT id FROM product_variants WHERE sku = $1', [v.sku]);
          if (ex.rows[0]) {
            await query(
              'UPDATE product_variants SET product_id=$1, size=$2, color=$3, stock=$4 WHERE id=$5',
              [productId, v.size || null, v.color || null, parseInt(v.stock) || 0, ex.rows[0].id]
            );
          } else {
            await query(
              'INSERT INTO product_variants (product_id, sku, size, color, stock) VALUES ($1,$2,$3,$4,$5)',
              [productId, v.sku, v.size || null, v.color || null, parseInt(v.stock) || 0]
            );
          }
        } else {
          await query(
            'INSERT INTO product_variants (product_id, size, color, stock) VALUES ($1,$2,$3,$4)',
            [productId, v.size || null, v.color || null, parseInt(v.stock) || 0]
          );
        }
      }
    } catch (err) {
      skipped.push({ slug, reason: err.message });
    }
  }

  await logAdminAction(req.user.id, 'product.import', { created, updated, skipped: skipped.length }, req.ip);
  res.json({ created, updated, skipped });
}));

// CSV export
router.get('/products/export', asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT p.id, p.slug, p.name, p.price, p.category,
            v.sku, v.size, v.color, v.stock
     FROM products p LEFT JOIN product_variants v ON v.product_id = p.id
     ORDER BY p.id, v.id`
  );
  const headers = ['id','slug','name','price','category','sku','size','color','stock'];
  const csv = [headers.join(',')];
  for (const r of rows) {
    csv.push(headers.map(h => JSON.stringify(r[h] ?? '')).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
  res.send(csv.join('\n'));
}));

// ───────── Orders ─────────
router.get('/orders', asyncHandler(async (req, res) => {
  const { status, payment_method, has_preorder } = req.query;
  const params = [];
  const conditions = [];
  if (status)         { params.push(status);         conditions.push(`o.status = $${params.length}`); }
  if (payment_method) { params.push(payment_method); conditions.push(`o.payment_method = $${params.length}`); }
  if (has_preorder === 'true') {
    conditions.push(`EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.is_preorder = true)`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT o.id, o.order_number, o.total, o.status, o.payment_status, o.payment_method, o.created_at,
            o.user_id,
            COALESCE(u.email, o.email) AS customer_email,
            u.name AS user_name
     FROM orders o LEFT JOIN users u ON u.id = o.user_id
     ${where} ORDER BY o.created_at DESC LIMIT 200`,
    params
  );
  res.json({ items: rows, data: rows });
}));

// ───────── Order detail ─────────
router.get('/orders/:id', asyncHandler(async (req, res) => {
  const { rows: [order] } = await query(
    `SELECT o.*, COALESCE(u.name, o.email) AS customer_name, u.email AS user_email
     FROM orders o LEFT JOIN users u ON o.user_id = u.id
     WHERE o.id = $1`,
    [req.params.id]
  );
  if (!order) throw notFound('Order not found');

  const [{ rows: items }, { rows: history }, { rows: edits }] = await Promise.all([
    query(
      `SELECT oi.*, pv.sku, pv.size, pv.color, p.name AS product_name, p.images
       FROM order_items oi
       JOIN product_variants pv ON oi.variant_id = pv.id
       JOIN products p ON pv.product_id = p.id
       WHERE oi.order_id = $1`,
      [req.params.id]
    ),
    query('SELECT * FROM order_status_history WHERE order_id=$1 ORDER BY created_at ASC', [req.params.id]),
    query(
      `SELECT oe.*, u.name AS admin_name FROM order_edits oe
       LEFT JOIN users u ON oe.admin_id = u.id
       WHERE oe.order_id=$1 ORDER BY oe.created_at DESC`,
      [req.params.id]
    ),
  ]);

  res.json({ ...order, items, status_history: history, edits });
}));

// ───────── Manual order creation ─────────
router.post(
  '/orders/manual',
  body('items').isArray({ min: 1 }),
  body('payment_method').isIn(['cod', 'paystack', 'manual_cash', 'manual_momo']),
  body('shipping_address').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { customer, items, shipping_address, payment_method, notes } = req.body;
    if (!customer) throw badRequest('customer is required');
    if (!customer.user_id && !customer.email) throw badRequest('customer.user_id or customer.email is required');

    // ── Resolve user_id ──────────────────────────────────────────────────────
    let userId;
    if (customer.user_id) {
      const { rows: [u] } = await query('SELECT id FROM users WHERE id=$1', [customer.user_id]);
      if (!u) throw notFound('Customer not found');
      userId = u.id;
    } else {
      const { rows: [u] } = await query('SELECT id FROM users WHERE LOWER(email)=LOWER($1)', [customer.email]);
      if (u) {
        userId = u.id;
      } else {
        let referralCode;
        for (let i = 0; i < 10; i++) {
          const code = Math.random().toString(36).toUpperCase().slice(2, 8);
          const { rows: [exists] } = await query('SELECT 1 FROM users WHERE referral_code=$1', [code]);
          if (!exists) { referralCode = code; break; }
        }
        const { rows: [newUser] } = await query(
          'INSERT INTO users (email, name, phone, role, referral_code) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [customer.email, customer.name ?? null, customer.phone ?? null, 'customer', referralCode]
        );
        userId = newUser.id;
      }
    }

    // ── Build order atomically ────────────────────────────────────────────────
    const result = await tx(async (client) => {
      let subtotal = 0;
      const resolvedItems = [];

      for (const item of items) {
        const { rows: [v] } = await client.query(
          `SELECT pv.id, pv.stock, COALESCE(pv.price_adjustment,0) AS adj, p.price
           FROM product_variants pv JOIN products p ON pv.product_id=p.id
           WHERE pv.id=$1 FOR UPDATE`,
          [item.variant_id]
        );
        if (!v) throw badRequest(`Variant ${item.variant_id} not found`);
        if (v.stock < item.quantity) throw badRequest(`Insufficient stock for variant ${item.variant_id}`);
        const unit_price = Number(v.price) + Number(v.adj);
        subtotal += unit_price * item.quantity;
        resolvedItems.push({ variant_id: item.variant_id, quantity: item.quantity, unit_price });
        await client.query('UPDATE product_variants SET stock=stock-$1 WHERE id=$2', [item.quantity, item.variant_id]);
      }

      const payment_status = ['manual_cash', 'manual_momo'].includes(payment_method) ? 'paid' : 'pending';
      const status = payment_method === 'cod' ? 'awaiting_confirmation' : 'processing';
      const orderNumber = `ORD-M-${Date.now().toString(36).toUpperCase()}`;

      const { rows: [order] } = await client.query(
        `INSERT INTO orders (user_id, email, order_number, total, status, payment_status, payment_method,
           shipping_address, source, created_by_admin_id, admin_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'admin_manual',$9,$10) RETURNING *`,
        [userId, customer.email ?? null, orderNumber, subtotal, status, payment_status,
         payment_method, shipping_address, req.user.id, notes ?? null]
      );

      for (const item of resolvedItems) {
        await client.query(
          'INSERT INTO order_items (order_id, variant_id, quantity, unit_price) VALUES ($1,$2,$3,$4)',
          [order.id, item.variant_id, item.quantity, item.unit_price]
        );
      }

      await client.query(
        'INSERT INTO order_status_history (order_id, status, note) VALUES ($1,$2,$3)',
        [order.id, status, 'Manual order created by admin']
      );

      return order;
    });

    await logAdminAction(req.user.id, 'order.manual_create',
      { order_id: result.id, user_id: userId, payment_method }, req.ip);

    res.status(201).json({ ok: true, order: result });
  })
);

// ───────── Edit order ─────────
router.put(
  '/orders/:id/edit',
  body('reason').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('reason is required', errors.array());
    const { shipping_address, status, admin_notes, items, total_override, reason } = req.body;
    const orderId = Number(req.params.id);

    const { rows: [order] } = await query('SELECT * FROM orders WHERE id=$1', [orderId]);
    if (!order) throw notFound('Order not found');

    const edits = [];

    await tx(async (client) => {
      if (shipping_address !== undefined) {
        edits.push({ field_name: 'shipping_address', before_value: order.shipping_address, after_value: shipping_address });
        await client.query('UPDATE orders SET shipping_address=$1 WHERE id=$2', [shipping_address, orderId]);
      }

      if (status !== undefined && status !== order.status) {
        edits.push({ field_name: 'status', before_value: order.status, after_value: status });
        await client.query('UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2', [status, orderId]);
        await client.query(
          'INSERT INTO order_status_history (order_id, status, note) VALUES ($1,$2,$3)',
          [orderId, status, `Force-set by admin: ${reason}`]
        );
        const NOTIFY_ON = new Set(['paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']);
        if (NOTIFY_ON.has(status)) {
          const email = order.email || order.shipping_address?.email;
          const tpl = emailTemplates[status]?.(order);
          if (email && tpl) sendEmail({ to: email, ...tpl }).catch(() => {});
        }
      }

      if (admin_notes) {
        const ts = new Date().toISOString();
        const appended = (order.admin_notes ?? '') + `\n[${ts}] ${req.user.name ?? 'Admin'}: ${admin_notes}`;
        edits.push({ field_name: 'admin_notes', before_value: order.admin_notes, after_value: appended });
        await client.query('UPDATE orders SET admin_notes=$1 WHERE id=$2', [appended, orderId]);
      }

      if (total_override !== undefined) {
        edits.push({ field_name: 'total', before_value: order.total, after_value: total_override });
        await client.query('UPDATE orders SET total=$1 WHERE id=$2', [total_override, orderId]);
      }

      let itemsChanged = false;
      if (items?.length) {
        for (const item of items) {
          if (item.action === 'remove') {
            const { rows: [oi] } = await client.query(
              'SELECT quantity, variant_id FROM order_items WHERE id=$1 AND order_id=$2',
              [item.order_item_id, orderId]
            );
            if (!oi) throw badRequest(`order_item ${item.order_item_id} not found`);
            await client.query('DELETE FROM order_items WHERE id=$1', [item.order_item_id]);
            await client.query('UPDATE product_variants SET stock=stock+$1 WHERE id=$2', [oi.quantity, oi.variant_id]);
            edits.push({ field_name: 'items', before_value: { removed: item.order_item_id, qty: oi.quantity }, after_value: null });
          } else if (item.action === 'add') {
            const { rows: [v] } = await client.query(
              'SELECT stock, COALESCE(price_adjustment,0) AS adj FROM product_variants WHERE id=$1 FOR UPDATE',
              [item.variant_id]
            );
            if (!v) throw badRequest(`variant ${item.variant_id} not found`);
            if (v.stock < item.quantity) throw badRequest(`Insufficient stock for variant ${item.variant_id}`);
            const { rows: [p] } = await client.query(
              'SELECT p.price FROM products p JOIN product_variants pv ON pv.product_id=p.id WHERE pv.id=$1',
              [item.variant_id]
            );
            const unit_price = Number(p.price) + Number(v.adj);
            await client.query(
              'INSERT INTO order_items (order_id, variant_id, quantity, unit_price) VALUES ($1,$2,$3,$4)',
              [orderId, item.variant_id, item.quantity, unit_price]
            );
            await client.query('UPDATE product_variants SET stock=stock-$1 WHERE id=$2', [item.quantity, item.variant_id]);
            edits.push({ field_name: 'items', before_value: null, after_value: { added: item.variant_id, qty: item.quantity } });
          } else if (item.action === 'update_qty') {
            const { rows: [oi] } = await client.query(
              'SELECT quantity, variant_id FROM order_items WHERE id=$1 AND order_id=$2 FOR UPDATE',
              [item.order_item_id, orderId]
            );
            if (!oi) throw badRequest(`order_item ${item.order_item_id} not found`);
            const delta = item.quantity - oi.quantity;
            if (delta > 0) {
              const { rows: [v] } = await client.query('SELECT stock FROM product_variants WHERE id=$1', [oi.variant_id]);
              if (v.stock < delta) throw badRequest('Insufficient stock');
              await client.query('UPDATE product_variants SET stock=stock-$1 WHERE id=$2', [delta, oi.variant_id]);
            } else if (delta < 0) {
              await client.query('UPDATE product_variants SET stock=stock+$1 WHERE id=$2', [Math.abs(delta), oi.variant_id]);
            }
            await client.query('UPDATE order_items SET quantity=$1 WHERE id=$2', [item.quantity, item.order_item_id]);
            edits.push({ field_name: 'items', before_value: { id: item.order_item_id, qty: oi.quantity }, after_value: { id: item.order_item_id, qty: item.quantity } });
          }
          itemsChanged = true;
        }

        if (itemsChanged && total_override === undefined) {
          const { rows: [sums] } = await client.query(
            'SELECT SUM(unit_price * quantity) AS subtotal FROM order_items WHERE order_id=$1',
            [orderId]
          );
          const new_total = Number(sums.subtotal ?? 0) + Number(order.shipping ?? 0) + Number(order.tax ?? 0) - Number(order.discount ?? 0);
          await client.query('UPDATE orders SET total=$1 WHERE id=$2', [new_total, orderId]);
        }
      }

      for (const e of edits) {
        await client.query(
          'INSERT INTO order_edits (order_id, field_name, before_value, after_value, reason, admin_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [orderId, e.field_name, e.before_value, e.after_value, reason, req.user.id]
        );
      }
    });

    await logAdminAction(req.user.id, 'order.edit',
      { id: orderId, fields: edits.map(e => e.field_name), reason }, req.ip);
    const { rows: [updated] } = await query('SELECT * FROM orders WHERE id=$1', [orderId]);
    res.json({ ok: true, order: updated });
  })
);

// ───────── Force order status ─────────
router.post(
  '/orders/:id/force-status',
  body('status').isIn(['pending', 'awaiting_confirmation', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']),
  body('reason').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { status, reason } = req.body;
    const orderId = Number(req.params.id);
    const { rows: [order] } = await query('SELECT * FROM orders WHERE id=$1', [orderId]);
    if (!order) throw notFound('Order not found');

    await tx(async (client) => {
      await client.query('UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2', [status, orderId]);
      await client.query(
        'INSERT INTO order_status_history (order_id, status, note) VALUES ($1,$2,$3)',
        [orderId, status, `Force-set by admin: ${reason}`]
      );
      await client.query(
        'INSERT INTO order_edits (order_id, field_name, before_value, after_value, reason, admin_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [orderId, 'status', order.status, status, reason, req.user.id]
      );
      if (['cancelled', 'refunded'].includes(status) && order.payment_status === 'paid') {
        await clawbackPointsForOrder(client, orderId);
      }
    });

    const email = order.email || order.shipping_address?.email;
    const tpl = emailTemplates[status]?.(order);
    if (email && tpl) sendEmail({ to: email, ...tpl }).catch(() => {});

    await logAdminAction(req.user.id, 'order.force_status',
      { id: orderId, from: order.status, to: status, reason }, req.ip);
    res.json({ ok: true });
  })
);

// ───────── Manual refund ─────────
router.post(
  '/orders/:id/manual-refund',
  body('amount_ghs').isFloat({ min: 0.01 }),
  body('method').isIn(['paystack', 'store_credit', 'manual_cash']),
  body('reason').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { amount_ghs, method, reason } = req.body;
    const orderId = Number(req.params.id);

    const { rows: [order] } = await query('SELECT * FROM orders WHERE id=$1', [orderId]);
    if (!order) throw notFound('Order not found');

    const { rows: [sums] } = await query(
      `SELECT COALESCE(SUM((after_value->>'amount')::numeric), 0) AS already_refunded
       FROM order_edits WHERE order_id=$1 AND field_name='manual_refund'`,
      [orderId]
    );
    const remaining = Number(order.total) - Number(sums.already_refunded);
    if (Number(amount_ghs) > remaining) {
      throw badRequest(`Cannot refund ${amount_ghs} — only ${remaining.toFixed(2)} remaining`);
    }

    if (method === 'paystack') {
      if (!order.paystack_reference) throw badRequest('No Paystack reference on this order');
      await refundTransaction(order.paystack_reference, Number(amount_ghs));
    }

    await tx(async (client) => {
      if (method === 'store_credit') {
        if (!order.user_id) throw badRequest('No user account on this order — cannot issue store credit');
        await client.query(
          'UPDATE users SET store_credit_ghs=store_credit_ghs+$1 WHERE id=$2',
          [amount_ghs, order.user_id]
        );
        await client.query(
          'INSERT INTO store_credit_ledger (user_id, amount_ghs, reason, related_id) VALUES ($1,$2,$3,$4)',
          [order.user_id, amount_ghs, 'manual_refund', orderId]
        );
      }
      await client.query(
        'INSERT INTO order_edits (order_id, field_name, before_value, after_value, reason, admin_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [orderId, 'manual_refund', { amount: 0 }, { amount: Number(amount_ghs), method }, reason, req.user.id]
      );
      await clawbackPointsForOrder(client, orderId);
    });

    await logAdminAction(req.user.id, 'order.manual_refund',
      { id: orderId, amount_ghs, method, reason }, req.ip);
    res.json({ ok: true });
  })
);

router.put(
  '/orders/:id/status',
  body('status').isIn(['pending','awaiting_confirmation','paid','processing','shipped','delivered','cancelled','refunded']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const updatedOrder = await tx(async (c) => {
      const { rows } = await c.query(
        'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
        [req.body.status, req.params.id]
      );
      if (!rows[0]) throw notFound();
      const ord = rows[0];
      await c.query(
        'INSERT INTO order_status_history (order_id, status, note) VALUES ($1, $2, $3)',
        [ord.id, ord.status, req.body.note ?? null]
      );
      // `payment_status` isn't touched by this UPDATE, so `ord.payment_status` here is still
      // the pre-update value — safe to use directly as the "was this a paid order" check.
      if (['cancelled', 'refunded'].includes(ord.status) && ord.payment_status === 'paid') {
        await clawbackPointsForOrder(c, ord.id);
      }
      return ord;
    });
    await logAdminAction(req.user.id, 'order.status', { id: updatedOrder.id, status: updatedOrder.status }, req.ip);
    const NOTIFY_ON = new Set(['paid', 'processing', 'shipped', 'delivered']);
    if (NOTIFY_ON.has(updatedOrder.status)) {
      const email = updatedOrder.email || updatedOrder.shipping_address?.email;
      const phone = updatedOrder.phone || updatedOrder.shipping_address?.phone;
      const tpl = emailTemplates[updatedOrder.status]?.(updatedOrder);
      if (email && tpl) sendEmail({ to: email, ...tpl }).catch(() => {});
      if (phone && smsTemplates[updatedOrder.status]) {
        sendSMS({ to: phone, message: smsTemplates[updatedOrder.status](updatedOrder) }).catch(() => {});
      }
    }
    res.json(updatedOrder);
  })
);

router.post('/orders/:id/refund', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) throw notFound('Order');
  if (order.payment_status !== 'paid') throw badRequest('Order is not in paid status');
  if (!order.paystack_reference) throw badRequest('No payment reference on record');

  // Call Paystack BEFORE the DB transaction — never hold a pg lock during an external HTTP call
  await refundTransaction(order.paystack_reference);

  let updated;
  await tx(async (c) => {
    const { rows: r } = await c.query(
      `UPDATE orders SET payment_status = 'refunded', status = 'cancelled'
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    updated = r[0];

    // Reverse any store credit spent on this order
    if (order.user_id) {
      const { rows: [spent] } = await c.query(
        `SELECT ABS(amount_ghs) AS amt FROM store_credit_ledger
         WHERE related_id = $1 AND reason = 'spent_on_order' LIMIT 1`,
        [order.id]
      );
      if (spent) {
        await c.query(
          'UPDATE users SET store_credit_ghs = store_credit_ghs + $1 WHERE id = $2',
          [spent.amt, order.user_id]
        );
        await c.query(
          `INSERT INTO store_credit_ledger (user_id, amount_ghs, reason, related_id)
           VALUES ($1, $2, 'refund', $3)`,
          [order.user_id, spent.amt, order.id]
        );
      }
    }
    // Roll back preorder_count for any preorder items in this order
    await rollbackPreorderCount(c, order.id);
    await clawbackPointsForOrder(c, order.id);
  });

  await logAdminAction(req.user.id, 'order.refund',
    { id: order.id, reference: order.paystack_reference }, req.ip);

  const email = order.email || order.shipping_address?.email;
  if (email) {
    const tpl = emailTemplates.refunded?.(updated);
    if (tpl) sendEmail({ to: email, ...tpl }).catch(() => {});
  }

  res.json(updated);
}));

// ── COD: confirm order ──
router.post('/orders/:id/confirm-cod', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) throw notFound('Order');
  if (order.payment_method !== 'cod') throw badRequest('Not a COD order');
  if (order.status !== 'awaiting_confirmation') throw badRequest('Order is not awaiting confirmation');

  const { rows: updated } = await query(
    `UPDATE orders SET status = 'processing' WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  await query(
    'INSERT INTO order_status_history (order_id, status, note) VALUES ($1,$2,$3)',
    [order.id, 'processing', 'COD order confirmed by admin']
  );
  await logAdminAction(req.user.id, 'order.cod.confirm', { id: order.id }, req.ip);

  const email = order.email || order.shipping_address?.email;
  const phone = order.phone || order.shipping_address?.phone;
  const tpl = emailTemplates.processing?.(updated[0]);
  if (email && tpl) sendEmail({ to: email, ...tpl }).catch(() => {});
  if (phone && smsTemplates.processing) {
    sendSMS({ to: phone, message: smsTemplates.processing(updated[0]) }).catch(() => {});
  }
  res.json(updated[0]);
}));

// ── COD: mark cash collected ──
router.post('/orders/:id/mark-paid', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) throw notFound('Order');
  if (order.payment_method !== 'cod') throw badRequest('Not a COD order');
  if (order.payment_status === 'paid') throw badRequest('Already marked as paid');

  const updatedOrder = await tx(async (c) => {
    const { rows: updated } = await c.query(
      `UPDATE orders SET payment_status = 'paid', status = 'delivered'
       WHERE id = $1 AND payment_status <> 'paid' RETURNING *`,
      [req.params.id]
    );
    const ord = updated[0];
    if (!ord) throw badRequest('Already marked as paid');
    await c.query(
      'INSERT INTO order_status_history (order_id, status, note) VALUES ($1,$2,$3)',
      [ord.id, 'delivered', 'Cash collected on delivery']
    );
    await awardPointsForOrder(c, ord);
    return ord;
  });

  await logAdminAction(req.user.id, 'order.cod.paid', { id: updatedOrder.id }, req.ip);

  const email = updatedOrder.email || updatedOrder.shipping_address?.email;
  const phone = updatedOrder.phone || updatedOrder.shipping_address?.phone;
  const tpl = emailTemplates.delivered?.(updatedOrder);
  if (email && tpl) sendEmail({ to: email, ...tpl }).catch(() => {});
  if (phone && smsTemplates.delivered) {
    sendSMS({ to: phone, message: smsTemplates.delivered(updatedOrder) }).catch(() => {});
  }
  checkAndQualifyReferral(updatedOrder.id, updatedOrder.user_id).catch(() => {});
  res.json(updatedOrder);
}));

// ── COD: cancel + restore stock ──
router.post('/orders/:id/cancel-cod', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) throw notFound('Order');
  if (order.payment_method !== 'cod') throw badRequest('Not a COD order');
  if (!['awaiting_confirmation', 'processing'].includes(order.status)) {
    throw badRequest('Order cannot be cancelled in its current state');
  }
  if (order.payment_status === 'paid') throw badRequest('Cannot cancel a paid order');

  const { rows: items } = await query(
    'SELECT variant_id, quantity, is_preorder FROM order_items WHERE order_id = $1',
    [order.id]
  );

  await tx(async (c) => {
    for (const item of items.filter((i) => !i.is_preorder)) {
      await c.query(
        'UPDATE product_variants SET stock = stock + $1 WHERE id = $2',
        [item.quantity, item.variant_id]
      );
    }
    await rollbackPreorderCount(c, order.id);
    await c.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
    await c.query(
      'INSERT INTO order_status_history (order_id, status, note) VALUES ($1,$2,$3)',
      [order.id, 'cancelled', 'COD order cancelled — stock restored']
    );
  });

  await logAdminAction(req.user.id, 'order.cod.cancel', { id: order.id }, req.ip);
  const { rows: updated } = await query('SELECT * FROM orders WHERE id = $1', [order.id]);
  res.json(updated[0]);
}));

// ───────── Users ─────────
router.get('/users', asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT id, email, name, role, is_blocked, last_login, created_at FROM users ORDER BY id DESC LIMIT 200`
  );
  res.json(rows);
}));

router.put('/users/:id/role',
  body('role').isIn(['customer','admin']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { rows } = await query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role',
      [req.body.role, req.params.id]
    );
    if (!rows[0]) throw notFound();
    await logAdminAction(req.user.id, 'user.role', { target: rows[0].id, role: rows[0].role }, req.ip);
    res.json(rows[0]);
  })
);

router.put('/users/:id/block',
  body('is_blocked').isBoolean(),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'UPDATE users SET is_blocked = $1 WHERE id = $2 RETURNING id, email, is_blocked',
      [req.body.is_blocked, req.params.id]
    );
    if (!rows[0]) throw notFound();
    await logAdminAction(req.user.id, 'user.block', { target: rows[0].id, blocked: rows[0].is_blocked }, req.ip);
    res.json(rows[0]);
  })
);

// ───────── Coupons ─────────
router.get('/coupons', asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT id, code, type, value,
            min_order_amount AS min_order,
            usage_limit,
            used_count AS usage_count,
            valid_from,
            valid_until AS expires_at,
            starts_at,
            first_order_only,
            buy_x,
            get_y,
            is_active, created_at
       FROM coupons ORDER BY created_at DESC`
  );
  res.json(rows);
}));

router.post(
  '/coupons',
  body('code').isString().trim().isLength({ min: 3 }),
  body('value').isFloat({ min: 0 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const c = req.body;
    // Accept 'percent' as alias for 'percentage'
    const type = c.type === 'percent' ? 'percentage' : (c.type || 'percentage');
    if (!['percentage','fixed','free_shipping'].includes(type)) throw badRequest('Invalid coupon type');
    const { rows } = await query(
      `INSERT INTO coupons
         (code,type,value,min_order_amount,usage_limit,valid_from,valid_until,
          starts_at,first_order_only,buy_x,get_y,is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,true)) RETURNING *`,
      [c.code.toUpperCase(), type, type === 'free_shipping' ? 0 : c.value,
       c.min_order ?? c.min_order_amount ?? 0,
       c.usage_limit ?? null, c.valid_from ?? null,
       c.expires_at ?? c.valid_until ?? null,
       c.starts_at ?? null,
       c.first_order_only ?? false,
       c.buy_x ?? null,
       c.get_y ?? null,
       c.is_active]
    );
    await logAdminAction(req.user.id, 'coupon.create', { id: rows[0].id }, req.ip);
    res.status(201).json(rows[0]);
  })
);

router.put('/coupons/:id', asyncHandler(async (req, res) => {
  const c = req.body;
  const type = c.type === 'percent' ? 'percentage' : (c.type ?? null);
  const { rows } = await query(
    `UPDATE coupons SET
      code = COALESCE($1,code), type = COALESCE($2,type), value = COALESCE($3,value),
      min_order_amount = COALESCE($4,min_order_amount),
      usage_limit = COALESCE($5,usage_limit),
      valid_from = COALESCE($6,valid_from), valid_until = COALESCE($7,valid_until),
      starts_at = COALESCE($8,starts_at),
      first_order_only = COALESCE($9,first_order_only),
      buy_x = COALESCE($10,buy_x),
      get_y = COALESCE($11,get_y),
      is_active = COALESCE($12,is_active)
     WHERE id = $13 RETURNING *`,
    [c.code ?? null, type,
     c.value != null ? (type === 'free_shipping' ? 0 : c.value) : null,
     c.min_order ?? c.min_order_amount ?? null,
     c.usage_limit ?? null, c.valid_from ?? null,
     c.expires_at ?? c.valid_until ?? null,
     c.starts_at ?? null,
     c.first_order_only ?? null,
     c.buy_x ?? null,
     c.get_y ?? null,
     c.is_active ?? null, req.params.id]
  );
  if (!rows[0]) throw notFound();
  res.json(rows[0]);
}));

router.delete('/coupons/:id', asyncHandler(async (req, res) => {
  await query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
  await logAdminAction(req.user.id, 'coupon.delete', { id: Number(req.params.id) }, req.ip);
  res.json({ ok: true });
}));

// ───────── Analytics ─────────
router.get('/analytics/sales', asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT to_char(date_trunc('day', created_at),'Mon DD') AS date,
            COUNT(*)::int AS orders,
            COALESCE(SUM(total),0)::float AS revenue
     FROM orders
     WHERE payment_status = 'paid' AND created_at >= NOW() - INTERVAL '30 days'
     GROUP BY date_trunc('day', created_at)
     ORDER BY date_trunc('day', created_at)`
  );
  res.json({ series: rows });
}));

router.get('/analytics/top-products', asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT product_name AS name,
            SUM(quantity)::int AS units_sold,
            SUM(quantity * unit_price)::float AS revenue
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.payment_status = 'paid'
     GROUP BY product_name ORDER BY units_sold DESC LIMIT 10`
  );
  res.json(rows);
}));

router.get('/analytics/customer-ltv', asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email,
            COUNT(o.id)::int AS order_count,
            COALESCE(SUM(o.total),0)::float AS total_spent
     FROM users u LEFT JOIN orders o ON o.user_id = u.id AND o.payment_status='paid'
     WHERE u.role='customer'
     GROUP BY u.id ORDER BY total_spent DESC LIMIT 20`
  );
  res.json(rows);
}));

// ───────── Loyalty overview ─────────
router.get('/loyalty/overview', asyncHandler(async (_req, res) => {
  const cfg = await getSettings();
  const redeemRate = Number(cfg.loyalty_redeem_rate_ghs ?? 0.1);

  const { rows: [totals] } = await query(
    `SELECT
       COALESCE(SUM(delta) FILTER (WHERE delta > 0), 0)::int AS total_issued,
       COALESCE(SUM(-delta) FILTER (WHERE reason = 'redeemed_credit'), 0)::int AS total_redeemed
     FROM loyalty_ledger`
  );
  const { rows: [{ outstanding }] } = await query(
    `SELECT COALESCE(SUM(loyalty_points), 0)::int AS outstanding FROM users`
  );
  const { rows: tierDistribution } = await query(
    `SELECT loyalty_tier AS tier, COUNT(*)::int AS count FROM users GROUP BY loyalty_tier`
  );
  const { rows: topMembers } = await query(
    `SELECT id, name, email, loyalty_points, loyalty_tier
     FROM users ORDER BY loyalty_points DESC LIMIT 10`
  );

  res.json({
    total_issued: totals.total_issued,
    total_redeemed: totals.total_redeemed,
    outstanding_points: outstanding,
    outstanding_liability_ghs: +(outstanding * redeemRate).toFixed(2),
    tier_distribution: tierDistribution,
    top_members: topMembers,
  });
}));

// ───────── Activity logs ─────────
router.get('/logs', asyncHandler(async (req, res) => {
  const { admin_id, action, from, to, q } = req.query;
  const params = [];
  const wh = [];
  if (admin_id) { params.push(admin_id); wh.push(`l.admin_id = $${params.length}`); }
  if (action) { params.push(action); wh.push(`l.action = $${params.length}`); }
  if (from) { params.push(from); wh.push(`l.created_at >= $${params.length}`); }
  if (to) { params.push(to); wh.push(`l.created_at <= $${params.length}`); }
  if (q) { params.push(`%${q}%`); wh.push(`(u.email ILIKE $${params.length} OR l.action ILIKE $${params.length})`); }
  const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT l.id, l.admin_id, l.action, l.details,
            l.ip_address AS ip,
            l.created_at,
            u.email AS admin_email,
            u.name  AS admin_name
     FROM admin_logs l LEFT JOIN users u ON u.id = l.admin_id
     ${where} ORDER BY l.created_at DESC LIMIT 200`,
    params
  );
  res.json(rows);
}));

// ───────── Returns ─────────

router.get('/returns', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const params = [];
  const whereClause = status ? `WHERE r.status = $${params.push(status)}` : '';
  const { rows } = await query(
    `SELECT r.*,
            u.name  AS customer_name,
            u.email AS customer_email,
            o.order_number,
            COUNT(ri.id)::int AS item_count
     FROM returns r
     JOIN users u  ON u.id = r.user_id
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN return_items ri ON ri.return_id = r.id
     ${whereClause}
     GROUP BY r.id, u.name, u.email, o.order_number
     ORDER BY r.created_at DESC LIMIT 200`,
    params
  );
  res.json(rows);
}));

router.get('/returns/:id', asyncHandler(async (req, res) => {
  const { rows: [ret] } = await query(
    `SELECT r.*,
            u.name  AS customer_name,
            u.email AS customer_email,
            o.order_number, o.total AS order_total, o.payment_method, o.paystack_reference
     FROM returns r
     JOIN users u  ON u.id = r.user_id
     JOIN orders o ON o.id = r.order_id
     WHERE r.id = $1`,
    [req.params.id]
  );
  if (!ret) throw notFound('Return');

  const { rows: items } = await query(
    `SELECT ri.*, oi.product_name, oi.unit_price, oi.variant_description, oi.product_image
     FROM return_items ri
     JOIN order_items oi ON oi.id = ri.order_item_id
     WHERE ri.return_id = $1`,
    [ret.id]
  );

  res.json({ ...ret, items });
}));

router.post('/returns/:id/approve', asyncHandler(async (req, res) => {
  const { rows: [ret] } = await query('SELECT * FROM returns WHERE id = $1', [req.params.id]);
  if (!ret) throw notFound('Return');
  if (ret.status !== 'requested') throw badRequest(`Cannot approve a return with status '${ret.status}'`);

  const { rows: [updated] } = await query(
    `UPDATE returns SET status = 'approved', approved_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  await logAdminAction(req.user.id, 'return.approve', { id: ret.id, rma: ret.rma_number }, req.ip);

  const { rows: [customer] } = await query('SELECT email, name FROM users WHERE id = $1', [ret.user_id]);
  if (customer?.email) {
    sendEmail({ to: customer.email, ...emailTemplates.returnApproved(updated) }).catch(() => {});
  }

  res.json(updated);
}));

router.post('/returns/:id/reject', asyncHandler(async (req, res) => {
  const { admin_note } = req.body;
  const { rows: [ret] } = await query('SELECT * FROM returns WHERE id = $1', [req.params.id]);
  if (!ret) throw notFound('Return');
  if (ret.status !== 'requested') throw badRequest(`Cannot reject a return with status '${ret.status}'`);

  const { rows: [updated] } = await query(
    `UPDATE returns SET status = 'rejected', rejected_at = NOW(), admin_note = $1
     WHERE id = $2 RETURNING *`,
    [admin_note ?? null, req.params.id]
  );
  await logAdminAction(req.user.id, 'return.reject', { id: ret.id, rma: ret.rma_number }, req.ip);

  const { rows: [customer] } = await query('SELECT email, name FROM users WHERE id = $1', [ret.user_id]);
  if (customer?.email) {
    sendEmail({ to: customer.email, ...emailTemplates.returnRejected(updated) }).catch(() => {});
  }

  res.json(updated);
}));

router.post('/returns/:id/receive', asyncHandler(async (req, res) => {
  const { rows: [ret] } = await query('SELECT * FROM returns WHERE id = $1', [req.params.id]);
  if (!ret) throw notFound('Return');
  if (ret.status !== 'approved') throw badRequest(`Cannot mark received — current status is '${ret.status}'`);

  const { rows: [updated] } = await query(
    `UPDATE returns SET status = 'received', received_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  await logAdminAction(req.user.id, 'return.receive', { id: ret.id, rma: ret.rma_number }, req.ip);

  res.json(updated);
}));

router.post('/returns/:id/refund', asyncHandler(async (req, res) => {
  const { refund_amount_ghs, restock } = req.body;
  if (!refund_amount_ghs || Number(refund_amount_ghs) <= 0)
    throw badRequest('refund_amount_ghs must be a positive number');

  const amount = Number(refund_amount_ghs);

  const { rows: [ret] } = await query('SELECT * FROM returns WHERE id = $1', [req.params.id]);
  if (!ret) throw notFound('Return');
  if (ret.status !== 'received')
    throw badRequest(`Cannot issue refund — current status is '${ret.status}'`);

  const { rows: [order] } = await query('SELECT * FROM orders WHERE id = $1', [ret.order_id]);

  // Validate refund amount doesn't exceed order total minus already-issued refunds on this order
  const { rows: [priorRefunds] } = await query(
    `SELECT COALESCE(SUM(refund_amount_ghs), 0)::float AS total_refunded
     FROM returns WHERE order_id = $1 AND status = 'refunded' AND id != $2`,
    [ret.order_id, ret.id]
  );
  const maxRefund = Number(order.total) - priorRefunds.total_refunded;
  if (amount > maxRefund + 0.001) // float tolerance
    throw badRequest(`Refund amount exceeds maximum of GH₵ ${maxRefund.toFixed(2)} for this order`);

  // Fetch return items before the transaction (needed for restock)
  const { rows: returnItems } = await query(
    'SELECT * FROM return_items WHERE return_id = $1',
    [ret.id]
  );

  // Call Paystack BEFORE the DB transaction — never hold a pg lock during an external HTTP call
  if (ret.resolution === 'refund' && order.payment_method !== 'cod') {
    if (!order.paystack_reference)
      throw badRequest('No Paystack reference found on this order');
    await refundTransaction(order.paystack_reference, amount); // throws on failure
  }

  let updatedReturn;
  await tx(async (c) => {
    if (ret.resolution === 'store_credit') {
      await c.query(
        'UPDATE users SET store_credit_ghs = store_credit_ghs + $1 WHERE id = $2',
        [amount, ret.user_id]
      );
      await c.query(
        `INSERT INTO store_credit_ledger (user_id, amount_ghs, reason, related_id)
         VALUES ($1, $2, 'refund', $3)`,
        [ret.user_id, amount, ret.id]
      );
    }

    if (restock) {
      for (const item of returnItems) {
        if (item.variant_id) {
          await c.query(
            'UPDATE product_variants SET stock = stock + $1 WHERE id = $2',
            [item.quantity, item.variant_id]
          );
        }
        await c.query(
          'UPDATE return_items SET restocked = TRUE WHERE id = $1',
          [item.id]
        );
      }
    }

    await clawbackPointsForOrder(c, ret.order_id);

    const { rows: [r] } = await c.query(
      `UPDATE returns SET status = 'refunded', refunded_at = NOW(), refund_amount_ghs = $1
       WHERE id = $2 RETURNING *`,
      [amount, ret.id]
    );
    updatedReturn = r;
  });

  await logAdminAction(
    req.user.id, 'return.refund',
    { id: ret.id, rma: ret.rma_number, amount, restock: !!restock },
    req.ip
  );

  const { rows: [customer] } = await query('SELECT email, name FROM users WHERE id = $1', [ret.user_id]);
  if (customer?.email) {
    sendEmail({ to: customer.email, ...emailTemplates.returnRefunded(updatedReturn, amount) }).catch(() => {});
  }

  res.json(updatedReturn);
}));

// ───────── Pre-orders ─────────

// GET /api/admin/preorder-items — all unfulfilled preorder lines across orders
router.get('/preorder-items', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT oi.id, oi.product_name, oi.preorder_ships_at, oi.quantity, oi.variant_description,
            o.id AS order_id, o.order_number, o.status, o.created_at,
            COALESCE(u.name, o.email) AS customer_name, u.email AS customer_email
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN users u ON u.id = o.user_id
     WHERE oi.is_preorder = true
       AND o.status NOT IN ('cancelled', 'refunded')
     ORDER BY oi.preorder_ships_at ASC NULLS LAST, oi.product_name`
  );
  res.json(rows);
}));

// POST /api/admin/products/:id/preorder/release — add stock, optionally clear preorder flag
router.post('/products/:id/preorder/release', asyncHandler(async (req, res) => {
  const { quantities = {}, clear_preorder = false } = req.body;

  for (const [variantId, stock] of Object.entries(quantities)) {
    if (Number(stock) > 0) {
      await query(
        'UPDATE product_variants SET stock = stock + $1 WHERE id = $2 AND product_id = $3',
        [Number(stock), Number(variantId), req.params.id]
      );
    }
  }

  if (clear_preorder) {
    await query(
      'UPDATE products SET is_preorder = false, preorder_count = 0 WHERE id = $1',
      [req.params.id]
    );
  }

  await logAdminAction(req.user.id, 'product.preorder.release',
    { id: req.params.id, quantities, clear_preorder }, req.ip);

  // Return pending order items for this product so admin knows what to ship
  const { rows: shippable } = await query(
    `SELECT oi.id, oi.product_name, oi.quantity, oi.variant_description,
            oi.preorder_ships_at, o.order_number, o.id AS order_id
     FROM order_items oi
     JOIN product_variants pv ON pv.id = oi.variant_id
     JOIN orders o ON o.id = oi.order_id
     WHERE pv.product_id = $1
       AND oi.is_preorder = true
       AND o.status NOT IN ('cancelled', 'refunded', 'delivered', 'shipped')
     ORDER BY o.created_at`,
    [req.params.id]
  );

  res.json({ shippable_count: shippable.length, items: shippable });
}));

// ───────── Customer Flags Bulk (must be before /customers/:id) ─────────

router.get('/customers/flags/bulk', asyncHandler(async (req, res) => {
  const ids = (req.query.ids ?? '').split(',').map(Number).filter(n => n > 0);
  if (!ids.length) return res.json({});
  if (ids.length > 500) throw badRequest('Too many IDs');
  const { rows } = await query(
    'SELECT * FROM customer_flags WHERE user_id = ANY($1) ORDER BY created_at ASC',
    [ids]
  );
  const grouped = {};
  for (const id of ids) grouped[id] = [];
  for (const row of rows) {
    const uid = row.user_id ?? row.customer_id;
    if (grouped[uid]) grouped[uid].push(row);
  }
  res.json(grouped);
}));

// ───────── Customer Detail ─────────

router.get('/customers/:id', asyncHandler(async (req, res) => {
  const cid = req.params.id;

  const { rows: [user] } = await query(
    `SELECT id, name, email, phone, role, is_blocked, totp_enabled,
            store_credit_ghs, loyalty_points, loyalty_tier, loyalty_lifetime_points,
            created_at, last_login
     FROM users WHERE id = $1`,
    [cid]
  );
  if (!user) throw notFound('Customer');

  const { rows: [orderStats] } = await query(
    `SELECT
       COUNT(*)::int                                                     AS total_orders,
       COUNT(*) FILTER (WHERE payment_status = 'paid')::int             AS paid_orders,
       COALESCE(SUM(total) FILTER (WHERE payment_status = 'paid'), 0)   AS total_spent_ghs,
       COALESCE(AVG(total) FILTER (WHERE payment_status = 'paid'), 0)   AS average_order_ghs,
       MIN(created_at) FILTER (WHERE payment_status = 'paid')           AS first_order_at,
       MAX(created_at) FILTER (WHERE payment_status = 'paid')           AS last_order_at
     FROM orders WHERE user_id = $1`,
    [cid]
  );

  const { rows: [{ returns_count }] } = await query(
    `SELECT COUNT(*)::int AS returns_count FROM returns WHERE user_id = $1`, [cid]
  );
  const { rows: [{ reviews_count }] } = await query(
    `SELECT COUNT(*)::int AS reviews_count FROM reviews WHERE user_id = $1`, [cid]
  );
  const { rows: [{ wishlist_count }] } = await query(
    `SELECT COUNT(*)::int AS wishlist_count FROM wishlists WHERE user_id = $1`, [cid]
  );

  res.json({
    user,
    stats: {
      ...orderStats,
      store_credit_balance_ghs: user.store_credit_ghs,
      returns_count,
      reviews_count,
      wishlist_count,
    },
  });
}));

router.get('/customers/:id/orders', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT o.id, o.order_number, o.total, o.status, o.payment_status,
            o.payment_method, o.created_at,
            COUNT(oi.id)::int AS item_count
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.user_id = $1
     GROUP BY o.id
     ORDER BY o.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

router.get('/customers/:id/returns', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.rma_number, r.status, r.resolution, r.created_at,
            o.order_number
     FROM returns r
     JOIN orders o ON r.order_id = o.id
     WHERE r.user_id = $1
     ORDER BY r.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

router.get('/customers/:id/reviews', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT rv.id, rv.rating, rv.comment, rv.created_at, rv.verified_purchase,
            p.id AS product_id, p.name AS product_name, p.slug AS product_slug
     FROM reviews rv
     JOIN products p ON rv.product_id = p.id
     WHERE rv.user_id = $1
     ORDER BY rv.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

router.get('/customers/:id/wishlist', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT w.id, w.created_at,
            p.id AS product_id, p.name, p.slug, p.price, p.images
     FROM wishlists w
     JOIN products p ON w.product_id = p.id
     WHERE w.user_id = $1
     ORDER BY w.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

router.get('/customers/:id/credit-ledger', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, amount_ghs, reason, related_id, created_at
     FROM store_credit_ledger
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

// Not feature-gated — admins can see/manage loyalty data even while feature_loyalty is off.
router.get('/customers/:id/loyalty-ledger', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, delta, reason, related_id, note, expires_at, created_at
     FROM loyalty_ledger
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

router.get('/customers/:id/notes', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT cn.id, cn.note, cn.pinned, cn.created_at, cn.updated_at,
            u.name AS author_name
     FROM customer_notes cn
     JOIN users u ON cn.author_id = u.id
     WHERE cn.customer_id = $1
     ORDER BY cn.pinned DESC, cn.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

router.post('/customers/:id/notes',
  body('note').isString().notEmpty(),
  body('pinned').optional().isBoolean(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { note, pinned = false } = req.body;
    const { rows: [created] } = await query(
      `INSERT INTO customer_notes (customer_id, author_id, note, pinned)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, req.user.id, note, pinned]
    );
    res.status(201).json(created);
  })
);

router.put('/customers/:id/notes/:nid',
  body('note').optional().isString(),
  body('pinned').optional().isBoolean(),
  asyncHandler(async (req, res) => {
    const { note, pinned } = req.body;
    const { rows: [updated] } = await query(
      `UPDATE customer_notes
       SET note       = COALESCE($1, note),
           pinned     = COALESCE($2, pinned),
           updated_at = now()
       WHERE id = $3 AND customer_id = $4
       RETURNING *`,
      [note ?? null, pinned ?? null, req.params.nid, req.params.id]
    );
    if (!updated) throw notFound('Note');
    res.json(updated);
  })
);

router.delete('/customers/:id/notes/:nid', asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM customer_notes WHERE id = $1 AND customer_id = $2`,
    [req.params.nid, req.params.id]
  );
  if (!rowCount) throw notFound('Note');
  res.status(204).end();
}));

router.post('/customers/:id/adjust-credit',
  body('amount_ghs').isFloat(),
  body('reason').isString().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { amount_ghs, reason, note } = req.body;
    const customerId = req.params.id;

    const result = await tx(async (client) => {
      const { rows: [user] } = await client.query(
        'SELECT store_credit_ghs FROM users WHERE id = $1 FOR UPDATE',
        [customerId]
      );
      if (!user) throw notFound('Customer');

      const current = parseFloat(user.store_credit_ghs) || 0;
      const newBalance = Math.max(0, current + parseFloat(amount_ghs));
      const actualDelta = newBalance - current;

      await client.query(
        'UPDATE users SET store_credit_ghs = $1 WHERE id = $2',
        [newBalance, customerId]
      );

      await client.query(
        `INSERT INTO store_credit_ledger (user_id, amount_ghs, reason)
         VALUES ($1, $2, $3)`,
        [customerId, actualDelta, 'manual_adjustment']
      );

      return { balance: newBalance, delta: actualDelta };
    });

    await logAdminAction(
      req.user.id,
      'credit.adjust',
      { customer_id: customerId, delta: result.delta, reason, note: note || null },
      req.ip
    );

    res.json(result);
  })
);

// Manual loyalty-points adjustment — never touches lifetime_points/loyalty_tier (symmetric
// with clawback: goodwill adjustments and refunds can grant/revoke spendable balance without
// inflating or demoting tier).
router.post('/customers/:id/loyalty/adjust',
  body('delta').isInt(),
  body('reason').isString().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { delta, reason, note } = req.body;
    const customerId = req.params.id;

    const result = await tx(async (client) => {
      const { rows: [user] } = await client.query(
        'SELECT loyalty_points FROM users WHERE id = $1 FOR UPDATE',
        [customerId]
      );
      if (!user) throw notFound('Customer');

      const current = user.loyalty_points;
      const newBalance = Math.max(0, current + Number(delta));
      const actualDelta = newBalance - current;

      await client.query(
        'UPDATE users SET loyalty_points = $1 WHERE id = $2',
        [newBalance, customerId]
      );

      await client.query(
        `INSERT INTO loyalty_ledger (user_id, delta, reason, note)
         VALUES ($1, $2, 'manual_adjustment', $3)`,
        [customerId, actualDelta, note || null]
      );

      return { balance: newBalance, delta: actualDelta };
    });

    await logAdminAction(
      req.user.id,
      'loyalty.adjust',
      { customer_id: customerId, delta: result.delta, reason, note: note || null },
      req.ip
    );

    res.json(result);
  })
);

// ───────── Today operational dashboard ─────────

router.get('/today', asyncHandler(async (req, res) => {
  const [
    todayStats, newCustomers, weekRevenue,
    codQueue, codTotal,
    toShip, toShipTotal,
    toApprove, toApproveTotal,
    toRefund, toRefundTotal,
    stockItems, outOfStockCount, lowStockCount,
    preorders, abandoned,
  ] = await Promise.all([

    // 1. Today revenue + order count
    query(`SELECT COUNT(*)::int AS today_orders,
             COALESCE(SUM(total) FILTER (WHERE payment_status='paid'),0) AS today_revenue_ghs
           FROM orders WHERE created_at::date = CURRENT_DATE`),

    // 2. New customers today
    query(`SELECT COUNT(*)::int AS today_new_customers FROM users WHERE created_at::date = CURRENT_DATE`),

    // 3. Week revenue (rolling 7 days, paid only)
    query(`SELECT COALESCE(SUM(total),0) AS week_revenue_ghs FROM orders
           WHERE payment_status='paid' AND created_at >= NOW() - INTERVAL '7 days'`),

    // 4a. COD awaiting confirmation (oldest first)
    query(`SELECT o.id, o.order_number, o.created_at, o.total AS total_ghs,
                  COALESCE(u.name, o.email) AS customer_name,
                  COALESCE(u.phone, o.shipping_address->>'phone') AS customer_phone,
                  COALESCE(u.email, o.email) AS customer_email,
                  COUNT(oi.id)::int AS items_count
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           LEFT JOIN order_items oi ON oi.order_id = o.id
           WHERE o.payment_method='cod' AND o.status='awaiting_confirmation'
           GROUP BY o.id, u.name, u.email, u.phone
           ORDER BY o.created_at ASC LIMIT 10`),

    // 4b. COD count
    query(`SELECT COUNT(*)::int AS v FROM orders WHERE payment_method='cod' AND status='awaiting_confirmation'`),

    // 5a. Orders to ship (paid + processing)
    query(`SELECT o.id, o.order_number, o.created_at, o.total AS total_ghs,
                  COALESCE(u.name, o.email) AS customer_name,
                  COUNT(oi.id)::int AS items_count,
                  bool_or(oi.is_preorder) AS has_preorder
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           LEFT JOIN order_items oi ON oi.order_id = o.id
           WHERE o.payment_status='paid' AND o.status='processing'
           GROUP BY o.id, u.name, u.email
           ORDER BY o.created_at ASC LIMIT 10`),

    // 5b. To-ship count
    query(`SELECT COUNT(*)::int AS v FROM orders WHERE payment_status='paid' AND status='processing'`),

    // 6a. Returns awaiting approval
    query(`SELECT r.id, r.rma_number, r.created_at,
                  u.name AS customer_name, o.order_number,
                  COUNT(ri.id)::int AS items_count,
                  STRING_AGG(DISTINCT ri.reason_code, ', ') AS reason_summary
           FROM returns r
           JOIN users u ON u.id = r.user_id
           JOIN orders o ON o.id = r.order_id
           LEFT JOIN return_items ri ON ri.return_id = r.id
           WHERE r.status='requested'
           GROUP BY r.id, u.name, o.order_number
           ORDER BY r.created_at ASC LIMIT 10`),

    // 6b. Approval count
    query(`SELECT COUNT(*)::int AS v FROM returns WHERE status='requested'`),

    // 7a. Returns awaiting refund
    query(`SELECT r.id, r.rma_number, r.received_at, r.resolution, r.refund_amount_ghs,
                  u.name AS customer_name
           FROM returns r
           JOIN users u ON u.id = r.user_id
           WHERE r.status='received'
           ORDER BY r.received_at ASC LIMIT 10`),

    // 7b. To-refund count
    query(`SELECT COUNT(*)::int AS v FROM returns WHERE status='received'`),

    // 8a. Low / out-of-stock (stock <= 5, active products only)
    query(`SELECT pv.id AS variant_id, pv.size, pv.color, pv.sku, pv.stock,
                  p.id AS product_id, p.name AS product_name, p.slug AS product_slug
           FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           WHERE pv.stock <= 5 AND p.is_active = true
           ORDER BY pv.stock ASC LIMIT 10`),

    // 8b. Out-of-stock count
    query(`SELECT COUNT(*)::int AS v FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           WHERE pv.stock = 0 AND p.is_active = true`),

    // 8c. Low-stock count (1-5)
    query(`SELECT COUNT(*)::int AS v FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           WHERE pv.stock BETWEEN 1 AND 5 AND p.is_active = true`),

    // 9. Pre-orders whose ship date is within 7 days
    query(`SELECT id AS product_id, name, slug AS product_slug, preorder_count, preorder_ships_at
           FROM products
           WHERE is_preorder = true AND preorder_ships_at <= NOW() + INTERVAL '7 days'
           ORDER BY preorder_ships_at ASC LIMIT 10`),

    // 10. Abandoned carts (72h window, same logic as dashboard/stats)
    query(`SELECT COUNT(*)::int AS v FROM carts c
           WHERE c.user_id IS NOT NULL
             AND c.updated_at BETWEEN NOW() - INTERVAL '72 hours' AND NOW() - INTERVAL '3 hours'
             AND (SELECT COUNT(*) FROM cart_items WHERE cart_id = c.id) > 0
             AND NOT EXISTS (
               SELECT 1 FROM orders o
               WHERE o.user_id = c.user_id
                 AND o.payment_status = 'paid'
                 AND o.created_at > c.updated_at
             )`),
  ]);

  res.json({
    date: new Date().toISOString().slice(0, 10),
    greeting_name: req.user.name,
    totals: {
      today_revenue_ghs:   parseFloat(todayStats.rows[0].today_revenue_ghs) || 0,
      today_orders:        todayStats.rows[0].today_orders,
      today_new_customers: newCustomers.rows[0].today_new_customers,
      week_revenue_ghs:    parseFloat(weekRevenue.rows[0].week_revenue_ghs) || 0,
    },
    queues: {
      cod_awaiting_confirmation:          codQueue.rows,
      cod_count:                          codTotal.rows[0].v,
      orders_to_ship:                     toShip.rows,
      orders_to_ship_count:               toShipTotal.rows[0].v,
      returns_awaiting_approval:          toApprove.rows,
      returns_awaiting_approval_count:    toApproveTotal.rows[0].v,
      returns_awaiting_refund:            toRefund.rows,
      returns_awaiting_refund_count:      toRefundTotal.rows[0].v,
      low_stock_variants:                 stockItems.rows,
      out_of_stock_count:                 outOfStockCount.rows[0].v,
      low_stock_count:                    lowStockCount.rows[0].v,
      pending_preorders_ready_to_release: preorders.rows,
      abandoned_carts_72h:                abandoned.rows[0].v,
    },
  });
}));

// ───────── Command Palette Search ─────────
router.get('/search', asyncHandler(async (req, res) => {
  const { q = '' } = req.query;
  const term = q.trim();
  if (term.length < 2) return res.json({ results: [] });
  const like = `%${term}%`;

  const [customers, orders, products, returns_] = await Promise.all([
    query(
      `SELECT id, name, email FROM users
       WHERE role='customer' AND (name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)
       LIMIT 4`,
      [like]
    ),
    query(
      `SELECT o.id, o.order_number, o.status, COALESCE(u.name, o.email) AS customer
       FROM orders o LEFT JOIN users u ON o.user_id = u.id
       WHERE o.order_number ILIKE $1 OR u.name ILIKE $1 OR o.email ILIKE $1
       LIMIT 4`,
      [like]
    ),
    query(
      `SELECT id, name, slug, category FROM products
       WHERE name ILIKE $1 OR slug ILIKE $1 OR category ILIKE $1
       LIMIT 4`,
      [like]
    ),
    query(
      `SELECT r.id, r.rma_number, r.status, COALESCE(u.name,'Customer') AS customer
       FROM returns r LEFT JOIN users u ON r.user_id = u.id
       WHERE r.rma_number ILIKE $1
       LIMIT 4`,
      [like]
    ),
  ]);

  const results = [
    ...customers.rows.map(r => ({
      type: 'customer', id: r.id,
      label: r.name, sublabel: r.email,
      href: `/admin/customers/${r.id}`,
    })),
    ...orders.rows.map(r => ({
      type: 'order', id: r.id,
      label: r.order_number, sublabel: `${r.customer} · ${r.status}`,
      href: `/admin/orders?highlight=${r.id}`,
    })),
    ...products.rows.map(r => ({
      type: 'product', id: r.id,
      label: r.name, sublabel: r.category,
      href: `/admin/products/${r.id}/edit`,
    })),
    ...returns_.rows.map(r => ({
      type: 'return', id: r.id,
      label: r.rma_number, sublabel: `${r.customer} · ${r.status}`,
      href: `/admin/returns/${r.id}`,
    })),
  ];

  res.json({ results });
}));

// ───────── View as Customer ─────────
router.post('/view-as/:customerId', asyncHandler(async (req, res) => {
  const customerId = Number(req.params.customerId);
  if (!Number.isInteger(customerId) || customerId < 1) throw badRequest('Invalid customer id');

  const { rows } = await query(
    'SELECT id, name, email, role FROM users WHERE id = $1',
    [customerId]
  );
  const customer = rows[0];
  if (!customer) throw notFound('Customer not found');
  if (customer.role === 'admin') throw forbidden('Cannot impersonate admin accounts');

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const token = jwt.sign(
    { impersonating_user_id: customerId, admin_id: req.user.id, mode: 'view-as' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  await logAdminAction(req.user.id, 'admin.view_as_started',
    { customer_id: customerId, expires_at: expiresAt }, req.ip);

  res.json({ token, customer: { id: customer.id, name: customer.name, email: customer.email }, expires_at: expiresAt });
}));

// ───────── Global Activity Feed ─────────
router.get('/activity', asyncHandler(async (req, res) => {
  const { type, since, limit = 50 } = req.query;
  const types    = type ? type.split(',').map(s => s.trim()).filter(Boolean) : null;
  const sinceTs  = since ? new Date(since) : null;
  const rowLimit = Math.min(Number(limit) || 50, 200);

  const { rows } = await query(`
    WITH activity AS (
      SELECT al.id::text || '_log' AS id, 'log' AS type,
        u.name AS actor,
        al.action,
        al.details AS meta,
        al.created_at
      FROM admin_logs al
      LEFT JOIN users u ON al.admin_id = u.id
      WHERE ($1::text[] IS NULL OR 'log' = ANY($1::text[]))
        AND ($2::timestamptz IS NULL OR al.created_at > $2)

      UNION ALL

      SELECT osh.id::text || '_order' AS id, 'order' AS type,
        COALESCE(u.name, o.email) AS actor,
        'order.' || osh.status AS action,
        jsonb_build_object('order_id', o.id, 'order_number', o.order_number,
                           'status', osh.status, 'note', osh.note) AS meta,
        osh.created_at
      FROM order_status_history osh
      JOIN orders o ON osh.order_id = o.id
      LEFT JOIN users u ON o.user_id = u.id
      WHERE ($1::text[] IS NULL OR 'order' = ANY($1::text[]))
        AND ($2::timestamptz IS NULL OR osh.created_at > $2)

      UNION ALL

      SELECT r.id::text || '_return' AS id, 'return' AS type,
        COALESCE(u.name, 'Customer') AS actor,
        'return.requested' AS action,
        jsonb_build_object('return_id', r.id, 'rma_number', r.rma_number,
                           'status', r.status) AS meta,
        r.created_at
      FROM returns r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE ($1::text[] IS NULL OR 'return' = ANY($1::text[]))
        AND ($2::timestamptz IS NULL OR r.created_at > $2)

      UNION ALL

      SELECT le.id::text || '_login' AS id, 'login' AS type,
        u.name AS actor,
        CASE WHEN le.success THEN 'login.success' ELSE 'login.failed' END AS action,
        jsonb_build_object('reason', le.reason) AS meta,
        le.created_at
      FROM login_events le
      JOIN users u ON le.user_id = u.id
      WHERE u.role = 'admin'
        AND ($1::text[] IS NULL OR 'login' = ANY($1::text[]))
        AND ($2::timestamptz IS NULL OR le.created_at > $2)
    )
    SELECT * FROM activity
    ORDER BY created_at DESC
    LIMIT $3
  `, [types, sinceTs, rowLimit]);

  const activity = rows.map(r => {
    const m = r.meta || {};
    let summary = r.action;
    let link = null;

    if (r.type === 'order') {
      summary = `Order ${m.order_number} → ${m.status}`;
      link = `/admin/orders?highlight=${m.order_id}`;
    } else if (r.type === 'return') {
      summary = `Return ${m.rma_number} requested`;
      link = `/admin/returns/${m.return_id}`;
    } else if (r.type === 'login') {
      summary = r.action === 'login.success'
        ? `${r.actor} signed in`
        : `Failed login for ${r.actor}`;
    } else if (r.type === 'log') {
      summary = `${r.actor ?? 'Admin'}: ${r.action}`;
      if (r.action?.startsWith('return.'))  link = `/admin/returns`;
      else if (r.action?.startsWith('order.'))   link = `/admin/orders`;
      else if (r.action?.startsWith('product.')) link = `/admin/products`;
      else if (r.action?.startsWith('user.'))    link = `/admin/users`;
    }

    return { id: r.id, type: r.type, actor: r.actor, action: r.action, summary, link, created_at: r.created_at };
  });

  res.json({ activity });
}));

// ── Bulk Actions ──────────────────────────────────────────────────────────────

router.post(
  '/orders/bulk',
  body('ids').isArray({ min: 1, max: 200 }),
  body('action').isIn(['mark_shipped', 'mark_delivered', 'cancel']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation error', errors.array());
    const { ids, action, tracking_number } = req.body;
    const STATUS_MAP = { mark_shipped: 'shipped', mark_delivered: 'delivered', cancel: 'cancelled' };
    const newStatus = STATUS_MAP[action];
    const succeeded = [], failed = [];
    for (const id of ids) {
      try {
        const { rows: [order] } = await query('SELECT id, status, payment_status, email, phone, shipping_address FROM orders WHERE id = $1', [id]);
        if (!order) { failed.push({ id, reason: 'Order not found' }); continue; }
        if (action === 'cancel' && ['cancelled', 'delivered', 'refunded'].includes(order.status)) {
          failed.push({ id, reason: `Cannot cancel order with status '${order.status}'` }); continue;
        }
        await tx(async (c) => {
          await c.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2', [newStatus, id]);
          await c.query(
            'INSERT INTO order_status_history (order_id, status, note) VALUES ($1, $2, $3)',
            [id, newStatus, tracking_number ?? null]
          );
          if (action === 'cancel' && order.payment_status === 'paid') {
            await clawbackPointsForOrder(c, id);
          }
        });
        const NOTIFY_ON = new Set(['shipped', 'delivered']);
        if (NOTIFY_ON.has(newStatus)) {
          const email = order.email || order.shipping_address?.email;
          const phone = order.phone || order.shipping_address?.phone;
          const tpl = emailTemplates[newStatus]?.(order);
          if (email && tpl) sendEmail(email, tpl.subject, tpl.html).catch(() => {});
          const smsTpl = smsTemplates[newStatus]?.(order);
          if (phone && smsTpl) sendSMS(phone, smsTpl).catch(() => {});
        }
        succeeded.push(id);
      } catch (err) { failed.push({ id, reason: err.message }); }
    }
    await logAdminAction(req.user.id, 'order.bulk', { action, count: ids.length, succeeded_count: succeeded.length, failed_count: failed.length }, req.ip);
    res.json({ succeeded, failed });
  })
);

router.post(
  '/returns/bulk',
  body('ids').isArray({ min: 1, max: 200 }),
  body('action').isIn(['approve', 'reject']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation error', errors.array());
    const { ids, action, admin_note } = req.body;
    const succeeded = [], failed = [];
    for (const id of ids) {
      try {
        const { rows: [ret] } = await query('SELECT id, status, rma_number, user_id FROM returns WHERE id = $1', [id]);
        if (!ret) { failed.push({ id, reason: 'Return not found' }); continue; }
        if (ret.status !== 'requested') {
          failed.push({ id, reason: `Cannot ${action} return with status '${ret.status}'` }); continue;
        }
        if (action === 'approve') {
          await query(`UPDATE returns SET status = 'approved', approved_at = NOW() WHERE id = $1`, [id]);
          const { rows: [u] } = await query('SELECT email FROM users WHERE id = $1', [ret.user_id]);
          const tpl = emailTemplates.returnApproved?.(ret);
          if (u?.email && tpl) sendEmail(u.email, tpl.subject, tpl.html).catch(() => {});
        } else {
          await query(`UPDATE returns SET status = 'rejected', rejected_at = NOW(), admin_note = $1 WHERE id = $2`, [admin_note ?? null, id]);
          const { rows: [u] } = await query('SELECT email FROM users WHERE id = $1', [ret.user_id]);
          const tpl = emailTemplates.returnRejected?.(ret);
          if (u?.email && tpl) sendEmail(u.email, tpl.subject, tpl.html).catch(() => {});
        }
        succeeded.push(id);
      } catch (err) { failed.push({ id, reason: err.message }); }
    }
    await logAdminAction(req.user.id, 'return.bulk', { action, count: ids.length, succeeded_count: succeeded.length, failed_count: failed.length }, req.ip);
    res.json({ succeeded, failed });
  })
);

router.post(
  '/products/bulk',
  body('ids').isArray({ min: 1, max: 200 }),
  body('action').isIn(['activate', 'deactivate', 'set_category', 'delete']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation error', errors.array());
    const { ids, action, category } = req.body;
    if (action === 'set_category' && !category) throw badRequest('category is required for set_category');
    const succeeded = [], failed = [], warnings = [];
    for (const id of ids) {
      try {
        if (action === 'delete') {
          const { rows: refs } = await query(
            `SELECT 1 FROM order_items oi
             JOIN product_variants pv ON pv.id = oi.variant_id
             WHERE pv.product_id = $1 LIMIT 1`,
            [id]
          );
          if (refs.length > 0) {
            await query('UPDATE products SET is_active = false WHERE id = $1', [id]);
            warnings.push({ id, message: 'Deactivated instead of deleted (has order history)' });
          } else {
            await query('DELETE FROM products WHERE id = $1', [id]);
            await logAdminAction(req.user.id, 'product.delete', { id }, req.ip);
          }
        } else if (action === 'activate') {
          await query('UPDATE products SET is_active = true WHERE id = $1', [id]);
        } else if (action === 'deactivate') {
          await query('UPDATE products SET is_active = false WHERE id = $1', [id]);
        } else if (action === 'set_category') {
          await query('UPDATE products SET category = $1 WHERE id = $2', [category, id]);
        }
        succeeded.push(id);
      } catch (err) { failed.push({ id, reason: err.message }); }
    }
    await logAdminAction(req.user.id, 'product.bulk', { action, count: ids.length, succeeded_count: succeeded.length, failed_count: failed.length }, req.ip);
    res.json({ succeeded, failed, warnings });
  })
);

router.post(
  '/users/bulk',
  body('ids').isArray({ min: 1, max: 200 }),
  body('action').isIn(['block', 'unblock']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation error', errors.array());
    const { ids, action } = req.body;
    const succeeded = [], failed = [];
    for (const id of ids) {
      try {
        const { rows: [u] } = await query('SELECT id, role FROM users WHERE id = $1', [id]);
        if (!u) { failed.push({ id, reason: 'User not found' }); continue; }
        if (u.role === 'admin') { failed.push({ id, reason: 'Cannot block admin accounts' }); continue; }
        await query('UPDATE users SET is_blocked = $1 WHERE id = $2', [action === 'block', id]);
        await logAdminAction(req.user.id, 'user.block', { target: id, blocked: action === 'block' }, req.ip);
        succeeded.push(id);
      } catch (err) { failed.push({ id, reason: err.message }); }
    }
    await logAdminAction(req.user.id, 'user.bulk', { action, count: ids.length, succeeded_count: succeeded.length, failed_count: failed.length }, req.ip);
    res.json({ succeeded, failed });
  })
);

router.post(
  '/variants/bulk-restock',
  body('adjustments').isArray({ min: 1, max: 200 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation error', errors.array());
    const { adjustments } = req.body;
    const succeeded = [], failed = [];
    for (const { variant_id, delta } of adjustments) {
      try {
        if (!Number.isInteger(Number(delta))) throw new Error('delta must be an integer');
        const { rows: [v] } = await query('SELECT id, stock FROM product_variants WHERE id = $1', [variant_id]);
        if (!v) { failed.push({ id: variant_id, reason: 'Variant not found' }); continue; }
        await query('UPDATE product_variants SET stock = $1 WHERE id = $2', [Math.max(0, v.stock + Number(delta)), variant_id]);
        succeeded.push(variant_id);
      } catch (err) { failed.push({ id: variant_id, reason: err.message }); }
    }
    await logAdminAction(req.user.id, 'variant.bulk_restock', { count: adjustments.length, succeeded_count: succeeded.length, failed_count: failed.length }, req.ip);
    res.json({ succeeded, failed });
  })
);

router.post(
  '/coupons/bulk',
  body('ids').isArray({ min: 1, max: 200 }),
  body('action').isIn(['activate', 'deactivate', 'delete']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation error', errors.array());
    const { ids, action } = req.body;
    const succeeded = [], failed = [];
    for (const id of ids) {
      try {
        if (action === 'delete') {
          await query('DELETE FROM coupons WHERE id = $1', [id]);
          await logAdminAction(req.user.id, 'coupon.delete', { id }, req.ip);
        } else {
          await query('UPDATE coupons SET is_active = $1 WHERE id = $2', [action === 'activate', id]);
        }
        succeeded.push(id);
      } catch (err) { failed.push({ id, reason: err.message }); }
    }
    await logAdminAction(req.user.id, 'coupon.bulk', { action, count: ids.length, succeeded_count: succeeded.length, failed_count: failed.length }, req.ip);
    res.json({ succeeded, failed });
  })
);

// ───────── Inventory adjustment ─────────
router.post(
  '/variants/:id/adjust',
  body('delta').isInt(),
  body('reason').isIn(['damaged', 'found', 'audit', 'theft', 'restock', 'manual_correction', 'other']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { delta, reason, note } = req.body;
    const variantId = Number(req.params.id);

    const result = await tx(async (client) => {
      const { rows: [v] } = await client.query(
        'SELECT id, stock FROM product_variants WHERE id=$1 FOR UPDATE',
        [variantId]
      );
      if (!v) throw notFound('Variant not found');
      const stock_before = v.stock;
      const stock_after = stock_before + Number(delta);
      if (stock_after < 0) throw badRequest(`Adjustment would result in negative stock (${stock_after})`);
      await client.query('UPDATE product_variants SET stock=$1 WHERE id=$2', [stock_after, variantId]);
      const { rows: [adj] } = await client.query(
        `INSERT INTO inventory_adjustments (variant_id, delta, reason, note, stock_before, stock_after, admin_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [variantId, delta, reason, note ?? null, stock_before, stock_after, req.user.id]
      );
      return { stock_before, stock_after, adjustment: adj };
    });

    await logAdminAction(req.user.id, 'variant.adjust', {
      variant_id: variantId, delta, reason,
      stock_before: result.stock_before, stock_after: result.stock_after,
    }, req.ip);
    res.json(result);
  })
);

router.get('/variants/:id/adjustment-history', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT ia.*, u.name AS admin_name
     FROM inventory_adjustments ia
     LEFT JOIN users u ON ia.admin_id = u.id
     WHERE ia.variant_id = $1
     ORDER BY ia.created_at DESC`,
    [Number(req.params.id)]
  );
  res.json({ adjustments: rows });
}));

// ───────── Message Templates ─────────

router.get('/message-templates', asyncHandler(async (req, res) => {
  const { channel, all } = req.query;
  const params = [];
  const conditions = [];
  if (!all) conditions.push('is_active = true');
  if (channel) { params.push(channel); conditions.push(`channel = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM message_templates ${where} ORDER BY channel, name`,
    params
  );
  res.json({ templates: rows });
}));

router.post(
  '/message-templates',
  body('name').notEmpty(),
  body('channel').isIn(['email', 'sms', 'whatsapp']),
  body('body').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { name, channel, subject, body: tmplBody, is_active = true } = req.body;
    const { rows: [row] } = await query(
      `INSERT INTO message_templates (name, channel, subject, body, is_active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, channel, subject ?? null, tmplBody, is_active]
    );
    await logAdminAction(req.user.id, 'template.create', { id: row.id, name, channel }, req.ip);
    res.status(201).json({ template: row });
  })
);

router.put(
  '/message-templates/:id',
  asyncHandler(async (req, res) => {
    const tid = Number(req.params.id);
    const { name, channel, subject, body: tmplBody, is_active } = req.body;
    const sets = [];
    const params = [];
    if (name !== undefined)      { params.push(name);      sets.push(`name=$${params.length}`); }
    if (channel !== undefined)   { params.push(channel);   sets.push(`channel=$${params.length}`); }
    if (subject !== undefined)   { params.push(subject);   sets.push(`subject=$${params.length}`); }
    if (tmplBody !== undefined)  { params.push(tmplBody);  sets.push(`body=$${params.length}`); }
    if (is_active !== undefined) { params.push(is_active); sets.push(`is_active=$${params.length}`); }
    if (!sets.length) throw badRequest('Nothing to update');
    params.push(tid);
    const { rows: [row] } = await query(
      `UPDATE message_templates SET ${sets.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!row) throw notFound('Template not found');
    await logAdminAction(req.user.id, 'template.update', { id: tid }, req.ip);
    res.json({ template: row });
  })
);

router.delete('/message-templates/:id', asyncHandler(async (req, res) => {
  const tid = Number(req.params.id);
  const { rows: [row] } = await query(
    'UPDATE message_templates SET is_active=false WHERE id=$1 RETURNING id',
    [tid]
  );
  if (!row) throw notFound('Template not found');
  await logAdminAction(req.user.id, 'template.delete', { id: tid }, req.ip);
  res.json({ ok: true });
}));

// ───────── Send Message ─────────

router.post(
  '/messages/send',
  body('customer_id').isInt(),
  body('channel').isIn(['email', 'sms', 'whatsapp']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { customer_id, order_id, channel, template_id, subject: subjectIn, body: bodyIn, recipient_override } = req.body;

    const { rows: [customer] } = await query(
      'SELECT id, name, email, phone, store_credit_ghs FROM users WHERE id=$1',
      [customer_id]
    );
    if (!customer) throw notFound('Customer not found');

    let order = null;
    if (order_id) {
      const { rows: [o] } = await query(
        'SELECT id, order_number, total, status FROM orders WHERE id=$1 AND user_id=$2',
        [order_id, customer_id]
      );
      order = o ?? null;
    }

    let template = null;
    if (template_id) {
      const { rows: [t] } = await query(
        'SELECT * FROM message_templates WHERE id=$1 AND is_active=true',
        [template_id]
      );
      template = t ?? null;
    }

    const context = {
      customer_name:     customer.name ?? '',
      customer_email:    customer.email ?? '',
      customer_phone:    customer.phone ?? '',
      order_number:      order?.order_number ?? '',
      order_total_ghs:   order ? `GH₵ ${Number(order.total).toFixed(2)}` : '',
      order_status:      order?.status ?? '',
      store_credit_ghs:  `GH₵ ${Number(customer.store_credit_ghs ?? 0).toFixed(2)}`,
      tracking_number:   '',
    };

    const rawBody    = bodyIn    ?? template?.body    ?? '';
    const rawSubject = subjectIn ?? template?.subject ?? '';
    const renderedBody    = renderTemplate(rawBody, context);
    const renderedSubject = renderTemplate(rawSubject, context);

    let recipient = recipient_override;
    if (!recipient) {
      recipient = channel === 'email' ? customer.email : customer.phone;
    }

    let status = 'sent';
    let wa_url = null;

    try {
      if (channel === 'email') {
        await sendEmail({ to: recipient, subject: renderedSubject, html: renderedBody, text: renderedBody });
      } else if (channel === 'sms') {
        await sendSMS({ to: recipient, message: renderedBody });
      } else {
        const e164 = (recipient ?? '').replace(/\D/g, '').replace(/^0/, '233');
        wa_url = `https://wa.me/${e164}?text=${encodeURIComponent(renderedBody)}`;
        status = 'pending_manual';
      }
    } catch {
      status = 'failed';
    }

    await query(
      `INSERT INTO outbound_messages
         (customer_id, admin_id, channel, template_id, subject, body, recipient, order_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [customer_id, req.user.id, channel, template_id ?? null, renderedSubject || null,
       renderedBody, recipient, order_id ?? null, status]
    );

    await logAdminAction(req.user.id, 'message.send', { customer_id, channel, status }, req.ip);
    res.json({ ok: true, ...(wa_url ? { wa_url } : {}) });
  })
);

// ───────── Customer Flags ─────────

router.get('/customers/:id/flags', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM customer_flags WHERE user_id=$1 ORDER BY created_at ASC',
    [Number(req.params.id)]
  );
  res.json({ flags: rows });
}));

router.post(
  '/customers/:id/flags',
  body('flag').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { flag, label, color } = req.body;
    const cid = Number(req.params.id);
    const { rows: [row] } = await query(
      `INSERT INTO customer_flags (user_id, flag, label, color, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [cid, flag, label ?? flag, color ?? '#6366f1', req.user.id]
    );
    await logAdminAction(req.user.id, 'customer.flag.add', { customer_id: cid, flag }, req.ip);
    res.status(201).json({ flag: row });
  })
);

router.delete('/customers/:id/flags/:flagId', asyncHandler(async (req, res) => {
  const cid = Number(req.params.id);
  const fid = Number(req.params.flagId);
  const { rows: [row] } = await query(
    'DELETE FROM customer_flags WHERE id=$1 AND user_id=$2 RETURNING id',
    [fid, cid]
  );
  if (!row) throw notFound('Flag not found');
  await logAdminAction(req.user.id, 'customer.flag.remove', { customer_id: cid, flag_id: fid }, req.ip);
  res.json({ ok: true });
}));

// ───────── Customer outbound messages ─────────

router.get('/customers/:id/messages', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT om.*, u.name AS admin_name
     FROM outbound_messages om
     LEFT JOIN users u ON om.admin_id = u.id
     WHERE om.customer_id=$1
     ORDER BY om.created_at DESC
     LIMIT 100`,
    [Number(req.params.id)]
  );
  res.json({ messages: rows });
}));

// ───────── Quick Actions ─────────

router.post('/customers/:id/resend-confirmation', asyncHandler(async (req, res) => {
  const cid = Number(req.params.id);
  const { rows: [customer] } = await query('SELECT id, email, name FROM users WHERE id=$1', [cid]);
  if (!customer) throw notFound('Customer not found');

  const { rows: [order] } = await query(
    `SELECT * FROM orders WHERE user_id=$1 AND payment_status='paid'
     ORDER BY created_at DESC LIMIT 1`,
    [cid]
  );
  if (!order) throw badRequest('No paid order found for this customer');

  const tpl = emailTemplates.orderConfirmation(order);
  await sendEmail({ to: customer.email, ...tpl });

  await query(
    `INSERT INTO outbound_messages
       (customer_id, admin_id, channel, subject, body, recipient, order_id, status)
     VALUES ($1,$2,'email',$3,$4,$5,$6,'sent')`,
    [cid, req.user.id, tpl.subject, tpl.text, customer.email, order.id]
  );

  await logAdminAction(req.user.id, 'customer.resend_confirmation', { customer_id: cid, order_id: order.id }, req.ip);
  res.json({ ok: true, order_number: order.order_number });
}));

router.post('/customers/:id/reset-password', asyncHandler(async (req, res) => {
  const cid = Number(req.params.id);
  const { rows: [user] } = await query('SELECT id, email FROM users WHERE id=$1', [cid]);
  if (!user) throw notFound('Customer not found');

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1,$2, NOW() + INTERVAL '1 hour')`,
    [user.id, `reset:${tokenHash}`]
  );

  const link = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  const tpl = emailTemplates.passwordReset(link);
  await sendEmail({ to: user.email, ...tpl });

  await query(
    `INSERT INTO outbound_messages
       (customer_id, admin_id, channel, subject, body, recipient, status)
     VALUES ($1,$2,'email',$3,$4,$5,'sent')`,
    [cid, req.user.id, tpl.subject, tpl.text, user.email]
  );

  await logAdminAction(req.user.id, 'customer.reset_password', { customer_id: cid }, req.ip);
  res.json({ ok: true });
}));

// ───────── Settings ─────────
router.get('/settings', asyncHandler(async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const { key, value, description } = req.body;
  if (!key || value === undefined || value === null) throw badRequest('key and value are required');
  const val = typeof value === 'string' ? value : JSON.stringify(value);
  await query(
    `INSERT INTO site_settings (key, value, description, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           description = COALESCE(EXCLUDED.description, site_settings.description),
           updated_at = NOW()`,
    [key, val, description ?? null]
  );
  invalidateSettings();
  await logAdminAction(req.user.id, 'settings.update', { key, value: val }, req.ip);
  res.json({ ok: true, key, value: val });
}));

// ───────── Job Triggers ─────────
router.post('/jobs/loyalty-expiry/run', asyncHandler(async (req, res) => {
  checkJobCooldown('loyalty-expiry');
  const result = await runLoyaltyExpireJob();
  await logAdminAction(req.user.id, 'job.run', { job: 'loyalty-expiry', result }, req.ip);
  res.json({ ok: true, ...result });
}));

router.post('/jobs/abandoned-cart/run', asyncHandler(async (req, res) => {
  checkJobCooldown('abandoned-cart');
  const result = await runAbandonedCartJob();
  await logAdminAction(req.user.id, 'job.run', { job: 'abandoned-cart', result }, req.ip);
  res.json({ ok: true, ...result });
}));

router.post('/jobs/preorder-stock-check/run', asyncHandler(async (req, res) => {
  checkJobCooldown('preorder-stock-check');
  const { rows } = await query(
    `SELECT oi.id, oi.order_id, p.name, p.preorder_ships_at
     FROM order_items oi
     JOIN product_variants pv ON oi.variant_id = pv.id
     JOIN products p ON pv.product_id = p.id
     WHERE oi.is_preorder = true
       AND p.preorder_ships_at IS NOT NULL
       AND p.preorder_ships_at <= NOW()
     ORDER BY p.preorder_ships_at ASC`
  );
  await logAdminAction(req.user.id, 'job.run', { job: 'preorder-stock-check', found: rows.length }, req.ip);
  res.json({ ok: true, found: rows.length, items: rows.slice(0, 20) });
}));

router.post('/jobs/backups/run', asyncHandler(async (_req, res) => {
  res.status(501).json({ error: 'Backup job not implemented' });
}));

export default router;

