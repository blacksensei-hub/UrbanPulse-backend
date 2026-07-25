import express from 'express';
import { query } from '../db/index.js';
import { asyncHandler } from '../utils/helpers.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /api/addresses — the current user's saved address book
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, label, name, line1, line2, city, state, zip, country, phone, is_default, created_at
       FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
}));

export default router;
