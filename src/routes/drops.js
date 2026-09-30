import express from 'express';
import { query } from '../db/index.js';
import { asyncHandler, badRequest, notFound } from '../utils/helpers.js';
import { dropLimiter } from '../utils/rateLimiter.js';
import { isMissingTable } from '../utils/stockAlerts.js';
import { ghanaPhone } from '../utils/phone.js';
import { newToken, welcomeOffer } from '../utils/drops.js';
import { logger } from '../utils/logger.js';

const router = express.Router();
const SOURCES = new Set(['home', 'footer']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const notOpen = (res) => res.status(503).json({ error: "Sign-ups aren't open yet. Try again soon." });

// GET /api/drops/offer: the welcome offer line for the sign-up forms, if one
// is set. The code itself is only given out after signing up.
router.get('/offer', asyncHandler(async (_req, res) => {
  const offer = await welcomeOffer().catch((err) => {
    if (!isMissingTable(err)) logger.error('welcome offer lookup failed', { err: err.message });
    return null;
  });
  // Not cached: right after the offer changes in admin, every page shows it.
  res.json({ offer: offer ? { label: offer.label, note: offer.note } : null });
}));

// POST /api/drops/subscribe { email?, phone?, source }: join the drop list.
// Joining again is fine (and re-joins someone who had unsubscribed). The
// answer is the same whether or not the contact was already on the list.
router.post('/subscribe', dropLimiter, asyncHandler(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const phoneRaw = String(req.body?.phone ?? '').trim();
  const phone = phoneRaw ? ghanaPhone(phoneRaw) : null;
  const source = SOURCES.has(req.body?.source) ? req.body.source : '';
  if (!email && !phoneRaw) throw badRequest('Add an email address or a phone number.');
  if (email && (email.length > 200 || !EMAIL.test(email))) throw badRequest("That email address doesn't look right.");
  if (phoneRaw && !phone) throw badRequest("That phone number doesn't look right. Try 024 123 4567.");

  const contacts = [email && ['email', email], phone && ['sms', phone]].filter(Boolean);
  try {
    for (const [channel, address] of contacts) {
      await query(
        `INSERT INTO drop_subscribers (channel, address, source, token) VALUES ($1, $2, $3, $4)
         ON CONFLICT (channel, address) DO UPDATE SET unsubscribed_at = NULL`,
        [channel, address, source, newToken()],
      );
    }
  } catch (err) {
    if (isMissingTable(err)) return notOpen(res);
    throw err;
  }
  const offer = await welcomeOffer().catch(() => null);
  res.status(201).json({ ok: true, welcome: offer });
}));

// ── Unsubscribe ──────────────────────────────────────────────────────────
// Every drop message links to /stop/<token>. Opening the link only shows who
// it's for; leaving takes a tap (a POST), because mail scanners open links.

function masked({ channel, address }) {
  if (channel === 'email') return address.replace(/^(.{1,2})[^@]*(@.+)$/, '$1•••$2');
  return `+${address.slice(0, 3)} •• ••• ${address.slice(-4)}`;
}

async function byToken(token) {
  try {
    const { rows: [s] } = await query(
      'SELECT id, channel, address, unsubscribed_at FROM drop_subscribers WHERE token = $1', [token],
    );
    return s ?? null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

router.get('/stop/:token', asyncHandler(async (req, res) => {
  const s = await byToken(req.params.token);
  if (!s) throw notFound("That link doesn't work. It may have been copied incompletely.");
  res.json({ channel: s.channel, contact: masked(s), subscribed: !s.unsubscribed_at });
}));

// Also the target of mail apps' one-click unsubscribe (List-Unsubscribe-Post).
router.post('/stop/:token', asyncHandler(async (req, res) => {
  const s = await byToken(req.params.token);
  if (!s) throw notFound("That link doesn't work. It may have been copied incompletely.");
  await query('UPDATE drop_subscribers SET unsubscribed_at = COALESCE(unsubscribed_at, NOW()) WHERE id = $1', [s.id]);
  res.json({ ok: true, channel: s.channel, contact: masked(s), subscribed: false });
}));

router.post('/stop/:token/undo', asyncHandler(async (req, res) => {
  const s = await byToken(req.params.token);
  if (!s) throw notFound("That link doesn't work.");
  await query('UPDATE drop_subscribers SET unsubscribed_at = NULL WHERE id = $1', [s.id]);
  res.json({ ok: true, channel: s.channel, contact: masked(s), subscribed: true });
}));

export default router;
