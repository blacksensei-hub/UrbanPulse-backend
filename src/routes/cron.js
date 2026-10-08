// Scheduled jobs, run by calling these endpoints on a timetable. On Vercel the
// API isn't a long-running process, so node-cron (jobs/index.js) never fires
// there; the scheduled-jobs GitHub workflow calls these instead. Every call
// must carry `Authorization: Bearer <CRON_SECRET>`; without CRON_SECRET set on
// the server, they all refuse.
import crypto from 'crypto';
import express from 'express';
import { asyncHandler } from '../utils/helpers.js';
import { runOrderExpiryJob } from '../jobs/orderExpiry.js';
import { runAbandonedCartJob } from '../jobs/abandonedCart.js';
import { runLoyaltyExpireJob } from '../jobs/loyaltyExpire.js';

const router = express.Router();

router.use((req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'Scheduled jobs are not set up on this server' });
  const given = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'Not allowed' });
  }
  next();
});

router.post('/expire-orders', asyncHandler(async (_req, res) => {
  res.json(await runOrderExpiryJob());
}));

// These two keep the switches they had under node-cron.
router.post('/abandoned-cart', asyncHandler(async (_req, res) => {
  if (process.env.ENABLE_CART_RECOVERY !== 'true') return res.json({ skipped: 'ENABLE_CART_RECOVERY is off' });
  res.json(await runAbandonedCartJob());
}));

router.post('/loyalty-expire', asyncHandler(async (_req, res) => {
  if (process.env.ENABLE_LOYALTY_EXPIRY !== 'true') return res.json({ skipped: 'ENABLE_LOYALTY_EXPIRY is off' });
  res.json(await runLoyaltyExpireJob());
}));

export default router;
