import { query, tx } from '../db/index.js';
import { getSettings } from './settingsCache.js';
import { logger } from './logger.js';
import { badRequest } from './helpers.js';

function isFeatureOff(cfg, key) {
  return cfg[key] === 'false' || cfg[key] === false;
}

export function getTierThresholds(cfg) {
  return {
    bronze: 0,
    silver: Number(cfg.loyalty_tier_silver_threshold ?? 500),
    gold: Number(cfg.loyalty_tier_gold_threshold ?? 2000),
    platinum: Number(cfg.loyalty_tier_platinum_threshold ?? 5000),
  };
}

export function tierForLifetimePoints(lifetime, thresholds) {
  if (lifetime >= thresholds.platinum) return 'platinum';
  if (lifetime >= thresholds.gold) return 'gold';
  if (lifetime >= thresholds.silver) return 'silver';
  return 'bronze';
}

// Idempotent — always safe to call with the freshest lifetime total.
export async function recomputeTier(client, userId, lifetimePoints, cfg) {
  const thresholds = getTierThresholds(cfg);
  const tier = tierForLifetimePoints(lifetimePoints, thresholds);
  await client.query(
    `UPDATE users SET loyalty_tier = $1 WHERE id = $2 AND loyalty_tier <> $1`,
    [tier, userId]
  );
  return tier;
}

// Pure — replays a user's full ledger history (ordered oldest-first) to work out how much of
// each earn "lot" is still unspent. The ledger only stores signed deltas, so this is the only
// way to know which points are oldest without a schema change (see the ledger-growth note in
// the loyalty plan doc: this is O(n) per user per call).
export function simulateLots(ledgerRows) {
  const lots = [];
  const lotByOrderId = new Map();

  for (const row of ledgerRows) {
    const delta = Number(row.delta);
    if (delta > 0) {
      const lot = { id: row.id, remaining: delta, expires_at: row.expires_at };
      lots.push(lot);
      if (row.reason === 'earned_purchase' && row.related_id != null) {
        lotByOrderId.set(row.related_id, lot);
      }
    } else {
      let toConsume = -delta;
      if (row.reason === 'refund_clawback' && row.related_id != null && lotByOrderId.has(row.related_id)) {
        // Targeted: undo exactly the lot this clawback offsets, not FIFO — a refund on one
        // order must never erode points earned from an unrelated order.
        const lot = lotByOrderId.get(row.related_id);
        lot.remaining = Math.max(0, lot.remaining - toConsume);
      } else {
        // redeemed_credit, expired, manual_adjustment, or an orphaned clawback: FIFO, oldest first.
        for (const lot of lots) {
          if (toConsume <= 0) break;
          const take = Math.min(lot.remaining, toConsume);
          lot.remaining -= take;
          toConsume -= take;
        }
      }
    }
  }
  return lots;
}

// Called when an order becomes paid, inside the caller's transaction. `order` is the
// just-updated order row (needs at least id, user_id, subtotal).
export async function awardPointsForOrder(client, order) {
  if (!order.user_id) return null; // guest order — nobody to credit

  const cfg = await getSettings();
  if (isFeatureOff(cfg, 'feature_loyalty')) return null;

  // Defensive idempotency guard — the caller's `WHERE payment_status <> 'paid'` guard already
  // ensures this only runs once per order, but this is a cheap extra safety net.
  const { rows: [existing] } = await client.query(
    `SELECT id FROM loyalty_ledger WHERE related_id = $1 AND reason = 'earned_purchase' LIMIT 1`,
    [order.id]
  );
  if (existing) return null;

  const { rows: [discountRow] } = await client.query(
    `SELECT discount_amount FROM order_coupons WHERE order_id = $1 LIMIT 1`,
    [order.id]
  );
  const discount = Number(discountRow?.discount_amount ?? 0);
  const earnBasis = Math.max(0, Number(order.subtotal) - discount);

  const earnRate = Number(cfg.loyalty_earn_rate ?? 1); // points per GH₵10 spent
  const pointsEarned = Math.floor((earnBasis / 10) * earnRate);
  if (pointsEarned <= 0) return { pointsEarned: 0 };

  const { rows: [user] } = await client.query(
    `SELECT loyalty_points, loyalty_lifetime_points FROM users WHERE id = $1 FOR UPDATE`,
    [order.user_id]
  );
  if (!user) return null;

  const expireDays = Number(cfg.loyalty_points_expire_days ?? 365);
  const newBalance = user.loyalty_points + pointsEarned;
  const newLifetime = user.loyalty_lifetime_points + pointsEarned;

  await client.query(
    `UPDATE users SET loyalty_points = $1, loyalty_lifetime_points = $2 WHERE id = $3`,
    [newBalance, newLifetime, order.user_id]
  );
  await client.query(
    `INSERT INTO loyalty_ledger (user_id, delta, reason, related_id, expires_at)
     VALUES ($1, $2, 'earned_purchase', $3, NOW() + ($4 || ' days')::interval)`,
    [order.user_id, pointsEarned, order.id, expireDays]
  );

  const tier = await recomputeTier(client, order.user_id, newLifetime, cfg);
  return { pointsEarned, newBalance, tier };
}

// Called when a paid order is refunded/cancelled, inside the caller's transaction. All-or-
// nothing per order: claws back the full original earn, clamped to the user's current balance
// so it can never go negative (the shortfall — points already spent or expired elsewhere — is
// recorded in the ledger note). Never touches lifetime points or tier, so a refund can never
// demote a customer.
export async function clawbackPointsForOrder(client, orderId) {
  const { rows: [alreadyClawedBack] } = await client.query(
    `SELECT id FROM loyalty_ledger WHERE related_id = $1 AND reason = 'refund_clawback' LIMIT 1`,
    [orderId]
  );
  if (alreadyClawedBack) return null;

  const { rows: [earnRow] } = await client.query(
    `SELECT user_id, delta FROM loyalty_ledger WHERE related_id = $1 AND reason = 'earned_purchase' LIMIT 1`,
    [orderId]
  );
  if (!earnRow) return null; // guest order, feature was off at award time, or 0 points earned

  const { rows: [user] } = await client.query(
    `SELECT loyalty_points FROM users WHERE id = $1 FOR UPDATE`,
    [earnRow.user_id]
  );
  if (!user) return null;

  const earned = earnRow.delta;
  const clawback = Math.min(earned, user.loyalty_points);
  const shortfall = earned - clawback;
  const note = shortfall > 0
    ? `${earned} pts originally earned; only ${clawback} available to claw back (${shortfall} already spent or expired)`
    : null;

  if (clawback > 0) {
    await client.query(
      `UPDATE users SET loyalty_points = loyalty_points - $1 WHERE id = $2`,
      [clawback, earnRow.user_id]
    );
  }
  await client.query(
    `INSERT INTO loyalty_ledger (user_id, delta, reason, related_id, note)
     VALUES ($1, $2, 'refund_clawback', $3, $4)`,
    [earnRow.user_id, -clawback, orderId, note]
  );

  return { userId: earnRow.user_id, clawback, shortfall };
}

// Called from the order-creation transaction after the order row exists. Re-validates against
// the freshest locked balance (safer than trusting the caller's pre-insert estimate — if the
// balance shrank due to a race, this throws and the whole order transaction rolls back).
export async function redeemPoints(client, userId, points, orderId) {
  const requested = Math.floor(Number(points) || 0);
  if (requested <= 0) return { pointsRedeemed: 0, cediValue: 0 };

  const cfg = await getSettings();
  const minRedeem = Number(cfg.loyalty_min_redeem_points ?? 100);
  const redeemRate = Number(cfg.loyalty_redeem_rate_ghs ?? 0.1);

  const { rows: [user] } = await client.query(
    `SELECT loyalty_points FROM users WHERE id = $1 FOR UPDATE`,
    [userId]
  );
  if (!user || requested > user.loyalty_points) {
    throw badRequest('Points balance changed — please try again');
  }
  if (requested < minRedeem) {
    throw badRequest(`Minimum redemption is ${minRedeem} points`);
  }

  const cediValue = +(requested * redeemRate).toFixed(2);
  await client.query(
    `UPDATE users SET loyalty_points = loyalty_points - $1 WHERE id = $2`,
    [requested, userId]
  );
  await client.query(
    `INSERT INTO loyalty_ledger (user_id, delta, reason, related_id) VALUES ($1, $2, 'redeemed_credit', $3)`,
    [userId, -requested, orderId]
  );

  return { pointsRedeemed: requested, cediValue };
}

// Not order-scoped — run by the cron job / admin manual-trigger endpoint. Runs regardless of
// feature_loyalty (existing points keep expiring even while the storefront feature is paused).
export async function expirePoints() {
  const { rows: candidates } = await query(
    `SELECT DISTINCT user_id FROM loyalty_ledger WHERE expires_at < NOW() AND delta > 0`
  );

  const summary = { usersChecked: candidates.length, usersExpired: 0, totalPointsExpired: 0 };

  for (const { user_id } of candidates) {
    try {
      await tx(async (c) => {
        const { rows: [user] } = await c.query(
          `SELECT loyalty_points FROM users WHERE id = $1 FOR UPDATE`,
          [user_id]
        );
        if (!user) return;

        const { rows: ledgerRows } = await c.query(
          `SELECT id, delta, reason, related_id, expires_at FROM loyalty_ledger
           WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
          [user_id]
        );
        const lots = simulateLots(ledgerRows);
        const now = new Date();
        const expiredLots = lots.filter(
          (l) => l.remaining > 0 && l.expires_at && new Date(l.expires_at) < now
        );
        if (!expiredLots.length) return;

        let total = 0;
        for (const lot of expiredLots) {
          await c.query(
            `INSERT INTO loyalty_ledger (user_id, delta, reason, related_id) VALUES ($1, $2, 'expired', $3)`,
            [user_id, -lot.remaining, lot.id]
          );
          total += lot.remaining;
        }
        await c.query(
          `UPDATE users SET loyalty_points = GREATEST(0, loyalty_points - $1) WHERE id = $2`,
          [total, user_id]
        );

        summary.usersExpired += 1;
        summary.totalPointsExpired += total;
      });
    } catch (err) {
      logger.error({ err, userId: user_id }, 'loyalty expirePoints: failed for user');
    }
  }

  return summary;
}
