import express from 'express';
import { query } from '../db/index.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../utils/helpers.js';
import { requireAuth, rejectViewAsWrites } from '../middleware/auth.js';
import { requireFeature } from '../utils/settingsCache.js';

const router = express.Router();

// GET /api/products  — list with filter/sort/paginate
router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(48, Math.max(1, Number(req.query.limit) || 12));
  const offset = (page - 1) * limit;
  const { category, minPrice, maxPrice, sort, size, color, inStock } = req.query;

  const where = ['is_active = TRUE'];
  const params = [];
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (minPrice) { params.push(Number(minPrice)); where.push(`price >= $${params.length}`); }
  if (maxPrice) { params.push(Number(maxPrice)); where.push(`price <= $${params.length}`); }
  if (size) {
    params.push(size);
    where.push(`EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = products.id AND pv.size = $${params.length})`);
  }
  if (color) {
    params.push(color);
    where.push(`EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = products.id AND pv.color = $${params.length})`);
  }
  if (inStock === 'true') {
    where.push(`EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = products.id AND pv.stock > 0)`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sortMap = {
    newest: 'created_at DESC',
    'price-asc': 'price ASC',
    'price-desc': 'price DESC',
    rating: 'rating DESC',
  };
  const orderBy = sortMap[sort] || 'created_at DESC';

  const countQ = await query(`SELECT COUNT(*)::int AS total FROM products ${whereSql}`, params);
  const total = countQ.rows[0].total;

  params.push(limit); params.push(offset);
  const { rows } = await query(
    `SELECT id, slug, name, price, compare_at_price, flash_sale_ends_at, images, category, tags, rating,
            is_preorder, preorder_ships_at, preorder_limit, preorder_count,
            ARRAY(SELECT DISTINCT pv.color FROM product_variants pv
                  WHERE pv.product_id = products.id AND pv.color IS NOT NULL
                  ORDER BY pv.color) AS colors
     FROM products ${whereSql} ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({ items: rows, data: rows, page, limit, total, totalPages: Math.ceil(total / limit) });
}));

// GET /api/products/suggest?q=
router.get('/suggest', asyncHandler(async (req, res) => {
  const { q = '' } = req.query;
  if (!q.trim()) return res.json([]);
  const { rows } = await query(
    `SELECT id, slug, name, images FROM products
     WHERE is_active = TRUE AND (name ILIKE $1 OR similarity(name, $2) > 0.15)
     ORDER BY similarity(name, $2) DESC
     LIMIT 6`,
    [`%${q}%`, q]
  );
  res.json(rows);
}));

// GET /api/products/search/q
router.get('/search/q', asyncHandler(async (req, res) => {
  const { q = '', category, minPrice, maxPrice } = req.query;
  const params = [`%${q}%`, q];
  let sql = `SELECT id, slug, name, price, compare_at_price, flash_sale_ends_at, images, category, tags, rating,
                    ARRAY(SELECT DISTINCT pv.color FROM product_variants pv
                          WHERE pv.product_id = products.id AND pv.color IS NOT NULL
                          ORDER BY pv.color) AS colors
             FROM products
             WHERE is_active = TRUE AND (name ILIKE $1 OR description ILIKE $1 OR similarity(name, $2) > 0.15)`;
  if (category) { params.push(category); sql += ` AND category = $${params.length}`; }
  if (minPrice)  { params.push(Number(minPrice)); sql += ` AND price >= $${params.length}`; }
  if (maxPrice)  { params.push(Number(maxPrice)); sql += ` AND price <= $${params.length}`; }
  sql += ' ORDER BY similarity(name, $2) DESC, rating DESC LIMIT 30';
  const { rows } = await query(sql, params);
  res.json({ items: rows, data: rows });
}));

// GET /api/products/by-ids?ids=1,2,3  — must be before /:slug
router.get('/by-ids', asyncHandler(async (req, res) => {
  const raw = String(req.query.ids || '');
  const ids = raw.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return res.json({ items: [] });

  const { rows } = await query(
    `SELECT id, slug, name, price, compare_at_price, flash_sale_ends_at, images, category, tags, rating,
            ARRAY(SELECT DISTINCT pv.color FROM product_variants pv
                  WHERE pv.product_id = products.id AND pv.color IS NOT NULL
                  ORDER BY pv.color) AS colors
     FROM products WHERE id = ANY($1::int[]) AND is_active = TRUE`,
    [ids]
  );

  // Preserve the requested order (most-recently-viewed first)
  const map = Object.fromEntries(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => map[id]).filter(Boolean);

  res.json({ items: ordered });
}));

// GET /api/products/:slug
router.get('/:slug', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM products WHERE slug = $1', [req.params.slug]);
  const product = rows[0];
  if (!product) throw notFound('Product not found');
  const variants = await query(
    'SELECT id, size, color, sku, stock FROM product_variants WHERE product_id = $1 ORDER BY id',
    [product.id]
  );
  const reviews = await query(
    `SELECT r.id, r.rating, r.comment, r.image_url, r.verified_purchase,
            r.created_at, r.user_id, u.name AS user_name
     FROM reviews r JOIN users u ON u.id = r.user_id
     WHERE r.product_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
    [product.id]
  );
  res.json({ ...product, variants: variants.rows, reviews: reviews.rows });
}));

// GET /api/products/:slug/social
router.get('/:slug/social', asyncHandler(async (req, res) => {
  const { rows: products } = await query(
    'SELECT id, name FROM products WHERE slug = $1 AND is_active = TRUE',
    [req.params.slug]
  );
  const product = products[0];
  if (!product) throw notFound('Product not found');

  const [soldResult, stockResult] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(oi.quantity), 0)::int AS sold_recently
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.product_name = $1
         AND o.payment_status = 'paid'
         AND o.status NOT IN ('cancelled', 'refunded')
         AND o.created_at >= NOW() - INTERVAL '30 days'`,
      [product.name]
    ),
    query(
      `SELECT size, color, stock
       FROM product_variants
       WHERE product_id = $1 AND stock BETWEEN 1 AND 5
       ORDER BY stock`,
      [product.id]
    ),
  ]);

  res.json({
    sold_recently: soldResult.rows[0].sold_recently,
    low_stock_variants: stockResult.rows,
  });
}));

// GET /api/products/:slug/related
router.get('/:slug/related', asyncHandler(async (req, res) => {
  const { rows: products } = await query(
    'SELECT id, category FROM products WHERE slug = $1 AND is_active = TRUE',
    [req.params.slug]
  );
  const product = products[0];
  if (!product) throw notFound('Product not found');

  const { rows } = await query(
    `SELECT id, slug, name, price, compare_at_price, flash_sale_ends_at, images, category, tags, rating,
            ARRAY(SELECT DISTINCT pv.color FROM product_variants pv
                  WHERE pv.product_id = products.id AND pv.color IS NOT NULL
                  ORDER BY pv.color) AS colors
     FROM products
     WHERE is_active = TRUE AND id != $1 AND category = $2
     ORDER BY rating DESC
     LIMIT 8`,
    [product.id, product.category]
  );

  res.json({ items: rows });
}));

// POST /api/products/:slug/reviews
router.post('/:slug/reviews', requireAuth, ...rejectViewAsWrites, requireFeature('feature_reviews'), asyncHandler(async (req, res) => {
  const { rows: products } = await query(
    'SELECT id, name FROM products WHERE slug = $1 AND is_active = TRUE',
    [req.params.slug]
  );
  const product = products[0];
  if (!product) throw notFound('Product not found');

  const { rating, comment, image_url } = req.body;
  if (!Number.isInteger(Number(rating)) || rating < 1 || rating > 5) {
    throw badRequest('Rating must be an integer between 1 and 5');
  }
  if (!comment || !String(comment).trim()) {
    throw badRequest('Comment is required');
  }

  const { rows: existing } = await query(
    'SELECT 1 FROM reviews WHERE product_id = $1 AND user_id = $2',
    [product.id, req.user.id]
  );
  if (existing[0]) throw badRequest('You have already reviewed this product');

  const { rows: orderCheck } = await query(
    `SELECT 1 FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.user_id = $1
       AND oi.product_name = $2
       AND o.payment_status = 'paid'
       AND o.status NOT IN ('cancelled', 'refunded')
     LIMIT 1`,
    [req.user.id, product.name]
  );
  if (!orderCheck[0]) throw forbidden('Only verified buyers can leave reviews');

  const { rows: inserted } = await query(
    `INSERT INTO reviews (product_id, user_id, rating, comment, image_url, verified_purchase)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     RETURNING id, rating, comment, image_url, verified_purchase, created_at, user_id`,
    [product.id, req.user.id, Number(rating), String(comment).trim(), image_url || null]
  );
  const review = inserted[0];

  await query(
    `UPDATE products
     SET rating = (SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews WHERE product_id = $1)
     WHERE id = $1`,
    [product.id]
  );

  res.status(201).json({ ...review, user_name: req.user.name });
}));

export default router;
