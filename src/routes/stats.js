import express from 'express';
import { query } from '../db/index.js';
import { asyncHandler } from '../utils/helpers.js';
import { statsLimiter } from '../utils/rateLimiter.js';
import { isMissingTable } from '../utils/stockAlerts.js';

const router = express.Router();

// Crawlers, link unfurlers and headless browsers aren't visitors.
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|headless|lighthouse|pingdom|monitor/i;
const DEVICES = new Set(['phone', 'tablet', 'desktop']);
const clean = (v, max = 60) => String(v ?? '').trim().toLowerCase().replace(/[^\w.\-+ ]/g, '').slice(0, max);

function sourceFrom(ref, ownHost) {
  try {
    const host = new URL(ref).hostname.replace(/^www\./, '').toLowerCase();
    if (!host || host === ownHost) return '';
    if (/(^|\.)instagram\.com$|l\.instagram\.com$/.test(host)) return 'instagram';
    if (/(^|\.)facebook\.com$|fb\.com$/.test(host)) return 'facebook';
    if (/(^|\.)(t\.co|twitter\.com|x\.com)$/.test(host)) return 'x';
    if (/tiktok\.com$/.test(host)) return 'tiktok';
    if (/whatsapp\.(com|net)$|wa\.me$/.test(host)) return 'whatsapp';
    if (/linkedin\.com$|lnkd\.in$/.test(host)) return 'linkedin';
    if (/(^|\.)google\./.test(host)) return 'google';
    return host.slice(0, 60);
  } catch {
    return '';
  }
}

// POST /api/stats/hit: one page view. Stores a daily count per page, source
// and device type, and nothing about the visitor: no IP address, no cookie,
// no user id. `landing` marks the first page of a visit.
router.post('/hit', statsLimiter, asyncHandler(async (req, res) => {
  res.status(204).end();                       // never make the page wait
  if (BOT.test(req.get('user-agent') || '')) return;
  const b = req.body || {};
  const path = String(b.path || '').split(/[?#]/)[0].slice(0, 160);
  if (!path.startsWith('/') || path.startsWith('/admin') || path.startsWith('/api')) return;
  const device = DEVICES.has(b.device) ? b.device : '';
  const ownHost = String(req.get('host') || '').replace(/^www\./, '').split(':')[0];
  const landing = b.landing === true;
  const source = landing ? (clean(b.utm_source) || sourceFrom(b.ref, ownHost)) : '';
  const medium = landing ? clean(b.utm_medium) : '';
  const campaign = landing ? clean(b.utm_campaign, 80) : '';
  try {
    await query(
      `INSERT INTO visit_stats (day, path, source, medium, campaign, device, views, landings)
       VALUES (NOW()::date, $1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT (day, path, source, medium, campaign, device)
       DO UPDATE SET views = visit_stats.views + 1, landings = visit_stats.landings + EXCLUDED.landings`,
      [path, source, medium, campaign, device, landing ? 1 : 0],
    );
  } catch (err) {
    if (!isMissingTable(err)) throw err;       // not migrated yet: counting is simply off
  }
}));

export default router;
