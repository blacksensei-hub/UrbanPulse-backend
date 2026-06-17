import express from 'express';
import { query } from '../db/index.js';
import { asyncHandler } from '../utils/helpers.js';
import { requireAuth } from '../middleware/auth.js';
import { requireFeature } from '../utils/settingsCache.js';

const router = express.Router();
router.use(requireFeature('feature_referrals'));

const REASON_LABELS = {
  referral_reward: 'Referral reward',
  referred_reward: 'Welcome credit',
  spent_on_order:  'Applied to order',
  refund:          'Credit refunded',
};

// GET /api/referrals/lookup/:code  — public, no PII beyond first name
router.get('/lookup/:code', asyncHandler(async (req, res) => {
  const { rows: [user] } = await query(
    'SELECT name FROM users WHERE referral_code = $1',
    [req.params.code.toUpperCase().trim()]
  );
  if (!user) return res.json({ valid: false });
  res.json({ valid: true, referrer_name: user.name.split(' ')[0] });
}));

// GET /api/referrals/me  — requires auth
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [me] } = await query(
    'SELECT referral_code, store_credit_ghs FROM users WHERE id = $1',
    [req.user.id]
  );

  const shareUrl =
    `${process.env.FRONTEND_URL}/?ref=${me.referral_code}&utm_source=referral&utm_medium=share`;
  const shareText =
    `I've been shopping at UrbanPulse — quality streetwear built to last. ` +
    `Use my link to get GH₵ 50 off your first order: ${shareUrl}`;

  const [signedUpResult, qualifiedResult, recentResult] = await Promise.all([
    query(
      'SELECT COUNT(*)::int AS n FROM referrals WHERE referrer_user_id = $1',
      [req.user.id]
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM referrals
       WHERE referrer_user_id = $1 AND status IN ('qualified', 'rewarded')`,
      [req.user.id]
    ),
    query(
      `SELECT u.name, r.status, r.created_at
       FROM referrals r
       JOIN users u ON u.id = r.referred_user_id
       WHERE r.referrer_user_id = $1
       ORDER BY r.created_at DESC LIMIT 10`,
      [req.user.id]
    ),
  ]);

  const qualified = qualifiedResult.rows[0].n;
  const referrals = recentResult.rows.map((r) => ({
    name: r.status === 'rewarded'
      ? r.name.split(' ')[0]
      : `${r.name[0]}***`,
    status: r.status,
    date: r.created_at,
  }));

  res.json({
    code: me.referral_code,
    share_url: shareUrl,
    share_text: shareText,
    stats: {
      signed_up: signedUpResult.rows[0].n,
      qualified,
      earned_ghs: qualified * 50,
    },
    referrals,
  });
}));

// GET /api/referrals/ledger  — requires auth, returns last 20 credit entries
router.get('/ledger', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, amount_ghs, reason, related_id, created_at
     FROM store_credit_ledger
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [req.user.id]
  );

  const entries = rows.map((r) => ({
    id: r.id,
    amount_ghs: Number(r.amount_ghs),
    reason: REASON_LABELS[r.reason] ?? r.reason,
    related_id: r.related_id,
    created_at: r.created_at,
  }));

  res.json(entries);
}));

export default router;
