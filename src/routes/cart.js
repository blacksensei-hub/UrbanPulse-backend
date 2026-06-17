import express from 'express';
import { body, validationResult } from 'express-validator';
import { query, tx } from '../db/index.js';
import { asyncHandler, badRequest, notFound } from '../utils/helpers.js';
import { optionalAuth, viewAsMiddleware, rejectViewAsWrites } from '../middleware/auth.js';

const router = express.Router();

// Resolve a cart from req.user or session_id (header X-Session-Id)
async function resolveCart(req, create = false) {
  if (req.user) {
    const r = await query('SELECT * FROM carts WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [req.user.id]);
    if (r.rows[0]) return r.rows[0];
    if (create) {
      const c = await query('INSERT INTO carts (user_id) VALUES ($1) RETURNING *', [req.user.id]);
      return c.rows[0];
    }
  } else {
    const sid = req.get('X-Session-Id');
    if (!sid) return null;
    const r = await query('SELECT * FROM carts WHERE session_id = $1 ORDER BY id DESC LIMIT 1', [sid]);
    if (r.rows[0]) return r.rows[0];
    if (create) {
      const c = await query('INSERT INTO carts (session_id) VALUES ($1) RETURNING *', [sid]);
      return c.rows[0];
    }
  }
  return null;
}

async function cartPayload(cartId) {
  const items = await query(
    `SELECT ci.id, ci.quantity, ci.variant_id,
            pv.size, pv.color, pv.sku, pv.stock,
            (p.price + COALESCE(pv.price_adjustment,0)) AS price,
            p.id AS product_id, p.slug, p.name, p.images,
            (p.images)[1] AS image,
            p.is_preorder, p.preorder_ships_at
     FROM cart_items ci
     JOIN product_variants pv ON pv.id = ci.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE ci.cart_id = $1
     ORDER BY ci.id`,
    [cartId]
  );
  const subtotal = items.rows.reduce((sum, it) => sum + Number(it.price) * it.quantity, 0);
  return { id: cartId, items: items.rows, subtotal: Number(subtotal.toFixed(2)) };
}

router.get('/', optionalAuth, viewAsMiddleware, asyncHandler(async (req, res) => {
  if (req.viewAs) {
    const { rows } = await query(
      'SELECT * FROM carts WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
      [req.viewAs.user_id]
    );
    if (!rows[0]) return res.json({ id: null, items: [], subtotal: 0 });
    return res.json(await cartPayload(rows[0].id));
  }
  const cart = await resolveCart(req, false);
  if (!cart) return res.json({ id: null, items: [], subtotal: 0 });
  res.json(await cartPayload(cart.id));
}));

router.post(
  '/items',
  optionalAuth,
  ...rejectViewAsWrites,
  body('variant_id').isInt({ min: 1 }),
  body('quantity').isInt({ min: 1, max: 99 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());
    const { variant_id, quantity } = req.body;

    const { rows: vRows } = await query(
      `SELECT pv.stock, p.is_preorder
       FROM product_variants pv JOIN products p ON p.id = pv.product_id
       WHERE pv.id = $1`,
      [variant_id]
    );
    if (!vRows[0]) throw notFound('Variant');
    const { stock, is_preorder } = vRows[0];
    if (!is_preorder && stock < quantity) throw badRequest(`Only ${stock} in stock`);

    const cart = await resolveCart(req, true);
    if (!cart) throw badRequest('Could not resolve cart');

    await tx(async (c) => {
      const existing = await c.query(
        'SELECT id, quantity FROM cart_items WHERE cart_id = $1 AND variant_id = $2',
        [cart.id, variant_id]
      );
      const currentQty = existing.rows[0]?.quantity ?? 0;
      const newTotal = currentQty + quantity;
      if (!is_preorder && newTotal > stock) throw badRequest(`Only ${stock} in stock`);
      if (existing.rows[0]) {
        await c.query('UPDATE cart_items SET quantity = $1 WHERE id = $2', [newTotal, existing.rows[0].id]);
      } else {
        await c.query(
          'INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1,$2,$3)',
          [cart.id, variant_id, quantity]
        );
      }
      await c.query('UPDATE carts SET updated_at = NOW() WHERE id = $1', [cart.id]);
    });

    res.json(await cartPayload(cart.id));
  })
);

router.put(
  '/items/:id',
  optionalAuth,
  ...rejectViewAsWrites,
  body('quantity').isInt({ min: 0, max: 99 }),
  asyncHandler(async (req, res) => {
    const cart = await resolveCart(req, false);
    if (!cart) throw notFound('Cart');
    const id = Number(req.params.id);
    if (req.body.quantity === 0) {
      await query('DELETE FROM cart_items WHERE id = $1 AND cart_id = $2', [id, cart.id]);
    } else {
      const { rows } = await query(
        `SELECT pv.stock FROM cart_items ci
         JOIN product_variants pv ON pv.id = ci.variant_id
         WHERE ci.id = $1 AND ci.cart_id = $2`,
        [id, cart.id]
      );
      if (!rows[0]) throw notFound('Cart item');
      if (req.body.quantity > rows[0].stock) throw badRequest(`Only ${rows[0].stock} in stock`);
      await query('UPDATE cart_items SET quantity = $1 WHERE id = $2 AND cart_id = $3', [
        req.body.quantity, id, cart.id,
      ]);
    }
    res.json(await cartPayload(cart.id));
  })
);

router.delete('/items/:id', optionalAuth, ...rejectViewAsWrites, asyncHandler(async (req, res) => {
  const cart = await resolveCart(req, false);
  if (!cart) throw notFound('Cart');
  await query('DELETE FROM cart_items WHERE id = $1 AND cart_id = $2', [req.params.id, cart.id]);
  res.json(await cartPayload(cart.id));
}));

export default router;
