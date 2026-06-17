import { query, tx } from '../db/index.js';
import { sendEmail, emailTemplates } from './email.js';
import { logger } from './logger.js';

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateReferralCode(len = 7) {
  let code = '';
  for (let i = 0; i < len; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  return code;
}

export async function awardReferralRewards(referralId) {
  let referrerInfo = null;
  let referredInfo = null;

  await tx(async (c) => {
    const { rows: [ref] } = await c.query(
      `SELECT r.referrer_user_id, r.referred_user_id,
              u1.email AS referrer_email, u1.name AS referrer_name,
              u2.email AS referred_email, u2.name AS referred_name
       FROM referrals r
       JOIN users u1 ON u1.id = r.referrer_user_id
       JOIN users u2 ON u2.id = r.referred_user_id
       WHERE r.id = $1 AND r.status = 'qualified'`,
      [referralId]
    );
    if (!ref) return; // idempotency guard — already rewarded or doesn't exist

    referrerInfo = { email: ref.referrer_email, name: ref.referrer_name };
    referredInfo = { email: ref.referred_email, name: ref.referred_name };

    await c.query(
      'UPDATE users SET store_credit_ghs = store_credit_ghs + 50 WHERE id = $1',
      [ref.referrer_user_id]
    );
    await c.query(
      `INSERT INTO store_credit_ledger (user_id, amount_ghs, reason, related_id)
       VALUES ($1, 50, 'referral_reward', $2)`,
      [ref.referrer_user_id, referralId]
    );

    await c.query(
      'UPDATE users SET store_credit_ghs = store_credit_ghs + 50 WHERE id = $1',
      [ref.referred_user_id]
    );
    await c.query(
      `INSERT INTO store_credit_ledger (user_id, amount_ghs, reason, related_id)
       VALUES ($1, 50, 'referred_reward', $2)`,
      [ref.referred_user_id, referralId]
    );

    await c.query(
      `UPDATE referrals SET status = 'rewarded', rewarded_at = NOW() WHERE id = $1`,
      [referralId]
    );
  });

  if (referrerInfo) {
    sendEmail({ to: referrerInfo.email, ...emailTemplates.referralReward(referrerInfo) }).catch(
      (err) => logger.warn(`Referral reward email to referrer failed: ${err.message}`)
    );
  }
  if (referredInfo) {
    sendEmail({ to: referredInfo.email, ...emailTemplates.referralReward(referredInfo) }).catch(
      (err) => logger.warn(`Referral reward email to referred failed: ${err.message}`)
    );
  }
}

export async function checkAndQualifyReferral(orderId, userId) {
  if (!userId) return;

  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM orders WHERE user_id = $1 AND payment_status = 'paid'`,
    [userId]
  );
  // count = 1 means this is the first paid order (current order already marked paid before this runs)
  if (count !== 1) return;

  const { rows: [ref] } = await query(
    `SELECT id FROM referrals WHERE referred_user_id = $1 AND status = 'pending'`,
    [userId]
  );
  if (!ref) return;

  await query(
    `UPDATE referrals
     SET status = 'qualified', qualified_at = NOW(), referrer_reward_ghs = 50, referred_reward_ghs = 50
     WHERE id = $1`,
    [ref.id]
  );

  await awardReferralRewards(ref.id);
}
