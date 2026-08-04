import express from 'express';
import { query } from '../db/index.js';
import { asyncHandler, notFound } from '../utils/helpers.js';

const router = express.Router();

// GET /api/content/:slug — public, only published pages
router.get('/:slug', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT slug, title, body, meta_description, updated_at
     FROM content_pages WHERE slug = $1 AND is_published = true`,
    [req.params.slug]
  );
  const page = rows[0];
  if (!page) throw notFound('Page not found');
  res.json(page);
}));

export default router;
