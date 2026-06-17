import express from 'express';
import { query } from '../db/index.js';
import { asyncHandler, notFound, badRequest } from '../utils/helpers.js';
import { requireAuth, viewAsMiddleware, rejectViewAsWrites } from '../middleware/auth.js';
import { requireFeature } from '../utils/settingsCache.js';

const router = express.Router();
router.use(requireFeature('feature_wishlist'));

// GET /api/wishlist
router.get('/', requireAuth, viewAsMiddleware, asyncHandler(async (req, res) => {
  const userId = req.viewAs?.user_id ?? req.user.id;
  const { rows } = await query(
    `SELECT w.id, w.created_at,
            p.id AS product_id, p.slug, p.name, p.price, p.compare_at_price,
            p.images, p.category, p.rating,
            json_agg(
              json_build_object('id', pv.id, 'size', pv.size, 'color', pv.color, 'stock', pv.stock)
              ORDER BY pv.id
            ) FILTER (WHERE pv.id IS NOT NULL) AS variants
     FROM wishlists w
     JOIN products p ON p.id = w.product_id
     LEFT JOIN product_variants pv ON pv.product_id = p.id
     WHERE w.user_id = $1
     GROUP BY w.id, p.id
     ORDER BY w.created_at DESC`,
    [userId]
  );
  res.json(rows);
}));

// POST /api/wishlist
router.post('/', requireAuth, ...rejectViewAsWrites, asyncHandler(async (req, res) => {
  const { product_id } = req.body;
  if (!product_id) throw badRequest('product_id is required');

  const { rows: products } = await query(
    'SELECT id FROM products WHERE id = $1 AND is_active = TRUE',
    [product_id]
  );
  if (!products[0]) throw notFound('Product not found');

  const { rows } = await query(
    `INSERT INTO wishlists (user_id, product_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, product_id) DO NOTHING
     RETURNING id, product_id, created_at`,
    [req.user.id, product_id]
  );

  if (rows[0]) return res.status(201).json(rows[0]);

  // Already in wishlist — return existing row
  const { rows: existing } = await query(
    'SELECT id, product_id, created_at FROM wishlists WHERE user_id = $1 AND product_id = $2',
    [req.user.id, product_id]
  );
  res.json(existing[0]);
}));

// DELETE /api/wishlist/:id
router.delete('/:id', requireAuth, ...rejectViewAsWrites, asyncHandler(async (req, res) => {
  const { rows } = await query(
    'DELETE FROM wishlists WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (!rows[0]) throw notFound('Wishlist item not found');
  res.json({ success: true });
}));

export default router;
