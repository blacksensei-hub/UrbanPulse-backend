import express from 'express';
import { query, tx } from '../db/index.js';
import { asyncHandler, badRequest, notFound } from '../utils/helpers.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const RETURN_COLS = 'id, label, name, line1, line2, city, state, zip, country, phone, is_default, created_at';

// GET /api/addresses — the current user's saved address book
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT ${RETURN_COLS}
       FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
}));

// POST /api/addresses — add a new address to the book
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { label, name, line1, line2, city, state, zip, country, phone, is_default } = req.body;
  if (!name || !line1 || !city) throw badRequest('name, line1, and city are required');

  const row = await tx(async (c) => {
    if (is_default) {
      await c.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    }
    const { rows: [{ count }] } = await c.query(
      'SELECT COUNT(*)::int AS count FROM addresses WHERE user_id = $1',
      [req.user.id]
    );
    const { rows: [created] } = await c.query(
      `INSERT INTO addresses (user_id, label, name, line1, line2, city, state, zip, country, phone, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING ${RETURN_COLS}`,
      [req.user.id, label || 'Home', name, line1, line2 ?? null, city, state ?? null,
       zip ?? null, country ?? 'Ghana', phone ?? null, !!is_default || count === 0]
    );
    return created;
  });
  res.status(201).json(row);
}));

// PUT /api/addresses/:id — update an existing address (partial; omitted fields keep their value)
router.put('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { label, name, line1, line2, city, state, zip, country, phone } = req.body;
  const { rows } = await query(
    `UPDATE addresses SET
       label = COALESCE($1, label), name = COALESCE($2, name), line1 = COALESCE($3, line1),
       line2 = COALESCE($4, line2), city = COALESCE($5, city), state = COALESCE($6, state),
       zip = COALESCE($7, zip), country = COALESCE($8, country), phone = COALESCE($9, phone),
       updated_at = NOW()
     WHERE id = $10 AND user_id = $11
     RETURNING ${RETURN_COLS}`,
    [label ?? null, name ?? null, line1 ?? null, line2 ?? null, city ?? null,
     state ?? null, zip ?? null, country ?? null, phone ?? null, req.params.id, req.user.id]
  );
  if (!rows[0]) throw notFound('Address not found');
  res.json(rows[0]);
}));

// DELETE /api/addresses/:id
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    'DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (!rows[0]) throw notFound('Address not found');
  res.json({ success: true });
}));

// POST /api/addresses/:id/default — make this the user's one default address
router.post('/:id/default', requireAuth, asyncHandler(async (req, res) => {
  const row = await tx(async (c) => {
    const { rows: target } = await c.query(
      'SELECT id FROM addresses WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!target[0]) throw notFound('Address not found');
    await c.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    const { rows: [updated] } = await c.query(
      `UPDATE addresses SET is_default = true WHERE id = $1 RETURNING ${RETURN_COLS}`,
      [req.params.id]
    );
    return updated;
  });
  res.json(row);
}));

export default router;
