import express from 'express';
import { query } from '../db/index.js';
import { asyncHandler } from '../utils/helpers.js';
import { requireAuth } from '../middleware/auth.js';
import { requireFeature, getSettings } from '../utils/settingsCache.js';
import { simulateLots, getTierThresholds } from '../utils/loyalty.js';

const router = express.Router();
router.use(requireFeature('feature_loyalty'));

const TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum'];

function buildLabel(row) {
  const pts = Math.abs(row.delta);
  const sign = row.delta >= 0 ? '+' : '-';
  const orderRef = row.order_number ? `#${row.order_number}` : `#${row.related_id}`;
  switch (row.reason) {
    case 'earned_purchase':
      return `Earned from order ${orderRef} · ${sign}${pts} pts`;
    case 'redeemed_credit':
      return `Redeemed on order ${orderRef} · ${sign}${pts} pts`;
    case 'refund_clawback':
      return `Refund adjustment on order ${orderRef} · ${sign}${pts} pts`;
    case 'expired':
      return `Expired · ${sign}${pts} pts`;
    case 'manual_adjustment':
      return `${row.delta >= 0 ? 'Bonus points' : 'Points adjustment'} · ${sign}${pts} pts`;
    default:
      return `${row.reason} · ${sign}${pts} pts`;
  }
}

// GET /api/loyalty/me
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const cfg = await getSettings();
  const { rows: [user] } = await query(
    'SELECT loyalty_points, loyalty_tier, loyalty_lifetime_points FROM users WHERE id = $1',
    [req.user.id]
  );

  const thresholds = getTierThresholds(cfg);
  const currentIndex = TIER_ORDER.indexOf(user.loyalty_tier);
  const nextTier = TIER_ORDER[currentIndex + 1] ?? null;

  let next_tier_progress_pct = 100;
  let next_tier_points_needed = 0;
  if (nextTier) {
    const currentThreshold = thresholds[TIER_ORDER[currentIndex]];
    const nextThreshold = thresholds[nextTier];
    const span = nextThreshold - currentThreshold;
    next_tier_progress_pct = span > 0
      ? Math.min(100, Math.max(0, Math.floor(((user.loyalty_lifetime_points - currentThreshold) / span) * 100)))
      : 100;
    next_tier_points_needed = Math.max(0, nextThreshold - user.loyalty_lifetime_points);
  }

  const { rows: ledgerRows } = await query(
    `SELECT id, delta, reason, related_id, expires_at FROM loyalty_ledger
     WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
    [req.user.id]
  );
  const lots = simulateLots(ledgerRows);
  const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const expiringLots = lots.filter((l) => l.remaining > 0 && l.expires_at && new Date(l.expires_at) <= soon);
  const expiring_soon = expiringLots.length
    ? {
        points: expiringLots.reduce((sum, l) => sum + l.remaining, 0),
        expires_at: expiringLots.reduce(
          (min, l) => (new Date(l.expires_at) < new Date(min) ? l.expires_at : min),
          expiringLots[0].expires_at
        ),
      }
    : { points: 0, expires_at: null };

  res.json({
    balance: user.loyalty_points,
    lifetime: user.loyalty_lifetime_points,
    tier: user.loyalty_tier,
    next_tier: nextTier,
    next_tier_progress_pct,
    next_tier_points_needed,
    expiring_soon,
    redeem_rate_ghs: Number(cfg.loyalty_redeem_rate_ghs ?? 0.1),
    min_redeem_points: Number(cfg.loyalty_min_redeem_points ?? 100),
    settings_snapshot: {
      earn_rate: Number(cfg.loyalty_earn_rate ?? 1),
      redeem_rate_ghs: Number(cfg.loyalty_redeem_rate_ghs ?? 0.1),
      min_redeem_points: Number(cfg.loyalty_min_redeem_points ?? 100),
      points_expire_days: Number(cfg.loyalty_points_expire_days ?? 365),
      tier_thresholds: thresholds,
    },
  });
}));

// GET /api/loyalty/ledger?limit=20&before=<date>
router.get('/ledger', requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const before = req.query.before ? new Date(req.query.before) : null;

  const params = [req.user.id, limit];
  let whereBefore = '';
  if (before && !isNaN(before.getTime())) {
    params.push(before.toISOString());
    whereBefore = 'AND l.created_at < $3';
  }

  const { rows } = await query(
    `SELECT l.id, l.delta, l.reason, l.related_id, l.created_at, o.order_number
     FROM loyalty_ledger l
     LEFT JOIN orders o
       ON o.id = l.related_id AND l.reason IN ('earned_purchase', 'redeemed_credit', 'refund_clawback')
     WHERE l.user_id = $1 ${whereBefore}
     ORDER BY l.created_at DESC
     LIMIT $2`,
    params
  );

  const entries = rows.map((r) => ({
    id: r.id,
    delta: r.delta,
    reason: r.reason,
    label: buildLabel(r),
    created_at: r.created_at,
  }));

  const next_before = rows.length === limit ? rows[rows.length - 1].created_at : null;
  res.json({ entries, next_before });
}));

// GET /api/loyalty/preview-redeem?points=N — no writes, for the checkout UI
router.get('/preview-redeem', requireAuth, asyncHandler(async (req, res) => {
  const points = Math.floor(Number(req.query.points) || 0);
  const cfg = await getSettings();
  const minRedeem = Number(cfg.loyalty_min_redeem_points ?? 100);
  const redeemRate = Number(cfg.loyalty_redeem_rate_ghs ?? 0.1);

  const { rows: [user] } = await query('SELECT loyalty_points FROM users WHERE id = $1', [req.user.id]);
  const balance = user?.loyalty_points ?? 0;

  let eligible = true;
  let reason_if_not = null;
  if (points <= 0) {
    eligible = false;
    reason_if_not = 'Enter a number of points to redeem';
  } else if (points < minRedeem) {
    eligible = false;
    reason_if_not = `Minimum redemption is ${minRedeem} points`;
  } else if (points > balance) {
    eligible = false;
    reason_if_not = `Exceeds your balance of ${balance} points`;
  }

  res.json({
    points,
    cedi_value: +(points * redeemRate).toFixed(2),
    eligible,
    reason_if_not,
  });
}));

export default router;
