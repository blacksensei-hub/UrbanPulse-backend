import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { generateSecret, verifySync, generateURI } from 'otplib';
import QRCode from 'qrcode';
import { query, tx } from '../db/index.js';
import { asyncHandler, badRequest, unauthorized, HttpError } from '../utils/helpers.js';
import { signAccess, signRefresh, requireAuth, COOKIE_OPTS, viewAsMiddleware, rejectViewAsWrites } from '../middleware/auth.js';
import { authLimiter, dataExportLimiter } from '../utils/rateLimiter.js';
import { sendEmail, emailTemplates } from '../utils/email.js';
import { generateReferralCode } from '../utils/referral.js';
import { logAdminAction } from '../utils/adminLog.js';
import { verifyGoogleIdToken } from '../utils/googleAuth.js';

const router = express.Router();

// ── Shared helpers ────────────────────────────────────────────────────────────

const validate = (req) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw badRequest('Validation failed', errors.array());
};

function parseUserAgent(ua = '') {
  const browser = /Edg/.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome'
    : /Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux' : /Android/.test(ua) ? 'Android' : 'device';
  return `${browser} on ${os}`;
}

function anonymizeIp(ip = '') {
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.xxx` : ip.replace(/:[^:]+$/, ':xxx');
}

function getIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || '0.0.0.0';
}

function generateRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () =>
    crypto.randomBytes(5).toString('base64url').slice(0, 8).toUpperCase()
  );
}

async function logLoginEvent(userId, req, success, reason) {
  const ip = getIp(req);
  const ua = req.headers['user-agent'] ?? '';
  await query(
    `INSERT INTO login_events (user_id, ip_address, user_agent, success, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId ?? null, ip, ua, success, reason]
  ).catch(() => {});
}

async function createSession(userId, refreshToken, req) {
  const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const ip = getIp(req);
  const ua = req.headers['user-agent'] ?? '';
  await query(
    `INSERT INTO user_sessions (user_id, token_hash, user_agent, ip_address, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [userId, hash, ua, ip]
  );
}

async function isNewDevice(userId, req) {
  const ip = getIp(req);
  const ua = req.headers['user-agent'] ?? '';
  const { rows } = await query(
    `SELECT 1 FROM login_events
     WHERE user_id = $1 AND success = true AND ip_address = $2 AND user_agent = $3
       AND created_at > NOW() - INTERVAL '90 days'
     LIMIT 1`,
    [userId, ip, ua]
  );
  return rows.length === 0;
}

async function sendNewDeviceAlert(user, req) {
  const ip = getIp(req);
  const device = parseUserAgent(req.headers['user-agent']);
  sendEmail({
    to: user.email,
    ...emailTemplates.loginAlert({
      name: user.name,
      device,
      ip: anonymizeIp(ip),
      time: new Date().toISOString(),
    }),
  }).catch(() => {});
}

async function finishLogin(user, req, res) {
  const access = signAccess(user);
  const refresh = signRefresh(user);
  const refreshHash = crypto.createHash('sha256').update(refresh).digest('hex');

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1,$2, NOW() + INTERVAL '7 days')`,
    [user.id, refreshHash]
  );
  await createSession(user.id, refresh, req);

  if (await isNewDevice(user.id, req)) {
    await sendNewDeviceAlert(user, req);
  }

  res
    .cookie('accessToken', access, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 })
    .cookie('refreshToken', refresh, { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 });
}

// Shared referral helper — used by both email signup and Google signup
async function applyReferralIfValid(referredUserId, referredEmail, incomingCode) {
  if (!incomingCode) return;
  const { rows: [referrer] } = await query(
    'SELECT id FROM users WHERE referral_code = $1',
    [incomingCode.toUpperCase().trim()]
  );
  if (!referrer || referrer.id === referredUserId) return;
  const { rows: [alreadyReferred] } = await query(
    'SELECT 1 FROM referrals WHERE referred_user_id = $1', [referredUserId]
  );
  if (alreadyReferred) return;
  await query(
    `INSERT INTO referrals (referrer_user_id, referred_user_id, referred_email, status)
     VALUES ($1, $2, $3, 'pending')`,
    [referrer.id, referredUserId, referredEmail]
  );
}

// Build the standard user response object (includes new Google/password fields)
function userPayload(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    referral_code: u.referral_code,
    store_credit_ghs: u.store_credit_ghs,
    loyalty_points: u.loyalty_points,
    loyalty_tier: u.loyalty_tier,
    loyalty_lifetime_points: u.loyalty_lifetime_points,
    totp_enabled: u.totp_enabled,
    avatar_url: u.avatar_url ?? null,
    email_verified: u.email_verified ?? false,
    has_google: Boolean(u.has_google),
    has_password: Boolean(u.has_password),
  };
}

// ── POST /api/auth/register ───────────────────────────────────────────────────

router.post(
  '/register',
  authLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('name').isString().trim().isLength({ min: 1, max: 100 }),
  asyncHandler(async (req, res) => {
    validate(req);
    const { email, password, name, referral_code: incomingCode } = req.body;
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows[0]) throw badRequest('Email already in use');
    const hash = await bcrypt.hash(password, 12);

    // Generate collision-safe referral code
    let referralCode;
    for (let attempt = 0; attempt < 5; attempt++) {
      referralCode = generateReferralCode();
      const { rows: clash } = await query('SELECT 1 FROM users WHERE referral_code = $1', [referralCode]);
      if (!clash[0]) break;
      if (attempt === 4) throw new HttpError(500, 'Code generation failed — please try again');
    }

    const { rows } = await query(
      `INSERT INTO users (email, password_hash, name, referral_code)
       VALUES ($1,$2,$3,$4)
       RETURNING id, email, name, role, referral_code, store_credit_ghs, loyalty_points, loyalty_tier, loyalty_lifetime_points, totp_enabled,
                 avatar_url, email_verified,
                 google_id IS NOT NULL AS has_google,
                 password_hash IS NOT NULL AS has_password`,
      [email, hash, name, referralCode]
    );
    const user = rows[0];

    await applyReferralIfValid(user.id, email, incomingCode);

    const access = signAccess(user);
    const refresh = signRefresh(user);
    const refreshHash = crypto.createHash('sha256').update(refresh).digest('hex');
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1,$2, NOW() + INTERVAL '7 days')`,
      [user.id, refreshHash]
    );
    await createSession(user.id, refresh, req);
    await logLoginEvent(user.id, req, true, 'password_ok');

    res
      .cookie('accessToken', access, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 })
      .cookie('refreshToken', refresh, { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 })
      .status(201)
      .json({ user: userPayload(user) });
  })
);

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post(
  '/login',
  authLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').isString(),
  asyncHandler(async (req, res) => {
    validate(req);
    const { email, password } = req.body;
    const { rows } = await query(
      `SELECT id, email, name, role, password_hash, is_blocked,
              referral_code, store_credit_ghs, loyalty_points, loyalty_tier, loyalty_lifetime_points, totp_enabled,
              avatar_url, email_verified,
              google_id IS NOT NULL AS has_google,
              password_hash IS NOT NULL AS has_password
       FROM users WHERE email = $1`,
      [email]
    );
    const user = rows[0];

    // Google-only account — password_hash is NULL
    if (user && !user.password_hash) {
      return res.status(400).json({
        message: 'This account uses Google sign-in. Sign in with Google or use the password reset flow to set a password.',
      });
    }

    if (!user || user.is_blocked || !(await bcrypt.compare(password, user.password_hash))) {
      // Log failure — avoid leaking whether the user exists
      await logLoginEvent(user?.id ?? null, req, false, 'password_bad');
      throw unauthorized('Invalid credentials');
    }

    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    if (!user.totp_enabled) {
      await logLoginEvent(user.id, req, true, 'password_ok');
      await finishLogin(user, req, res);
      return res.json({ user: userPayload(user) });
    }

    // TOTP required — issue short-lived challenge token instead of real tokens
    const challengeToken = jwt.sign(
      { sub: user.id, type: 'totp_challenge' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    res.json({ requires_totp: true, challenge_token: challengeToken });
  })
);

// ── POST /api/auth/login/verify-totp ─────────────────────────────────────────

router.post('/login/verify-totp', authLimiter, asyncHandler(async (req, res) => {
  const { challenge_token, code } = req.body;
  if (!challenge_token || !code) throw badRequest('challenge_token and code are required');

  let payload;
  try { payload = jwt.verify(challenge_token, process.env.JWT_SECRET); }
  catch { throw unauthorized('Challenge token invalid or expired'); }
  if (payload.type !== 'totp_challenge') throw unauthorized('Invalid token type');

  const { rows: [user] } = await query(
    `SELECT id, email, name, role, totp_secret, totp_enabled, totp_recovery_codes,
            referral_code, store_credit_ghs, loyalty_points, loyalty_tier, loyalty_lifetime_points, avatar_url, email_verified,
            google_id IS NOT NULL AS has_google,
            password_hash IS NOT NULL AS has_password
     FROM users WHERE id = $1`,
    [payload.sub]
  );
  if (!user || !user.totp_enabled || !user.totp_secret) throw unauthorized('Invalid session');

  let reason = null;

  if (verifySync({ token: code, secret: user.totp_secret, window: 1 })?.valid) {
    reason = 'totp_ok';
  } else {
    // Try recovery codes (bcrypt compare against each stored hash)
    const codes = user.totp_recovery_codes ?? [];
    let matchedIdx = -1;
    for (let i = 0; i < codes.length; i++) {
      if (await bcrypt.compare(code, codes[i])) { matchedIdx = i; break; }
    }
    if (matchedIdx === -1) {
      await logLoginEvent(user.id, req, false, 'totp_bad');
      throw unauthorized('Invalid code');
    }
    // Consume the used recovery code
    const remaining = codes.filter((_, i) => i !== matchedIdx);
    await query(
      'UPDATE users SET totp_recovery_codes = $1 WHERE id = $2',
      [JSON.stringify(remaining), user.id]
    );
    reason = 'recovery_used';
  }

  await logLoginEvent(user.id, req, true, reason);
  await finishLogin(user, req, res);

  res.json({ user: userPayload(user) });
}));

// ── POST /api/auth/google ─────────────────────────────────────────────────────

router.post('/google', authLimiter, asyncHandler(async (req, res) => {
  const { id_token, referral_code: incomingCode } = req.body;
  if (!id_token) throw badRequest('id_token is required');

  let gPayload;
  try {
    gPayload = await verifyGoogleIdToken(id_token);
  } catch (err) {
    await logLoginEvent(null, req, false, 'google_bad');
    return res.status(401).json({ message: 'Google sign-in failed' });
  }

  const { sub: googleSub, email, name, given_name, family_name, picture } = gPayload;
  const displayName = name || [given_name, family_name].filter(Boolean).join(' ') || email;
  const ip = getIp(req);

  // a) Look up by google_id first (returning Google user)
  let { rows: [user] } = await query(
    `SELECT id, email, name, role, is_blocked, totp_enabled,
            referral_code, store_credit_ghs, loyalty_points, loyalty_tier, loyalty_lifetime_points, avatar_url, email_verified,
            google_id IS NOT NULL AS has_google,
            password_hash IS NOT NULL AS has_password
     FROM users WHERE google_id = $1`,
    [googleSub]
  );

  if (!user) {
    // b) Look up by email
    const { rows: [byEmail] } = await query(
      `SELECT id, email, name, role, is_blocked, totp_enabled, google_id,
              referral_code, store_credit_ghs, loyalty_points, loyalty_tier, loyalty_lifetime_points, avatar_url, email_verified,
              google_id IS NOT NULL AS has_google,
              password_hash IS NOT NULL AS has_password
       FROM users WHERE email = $1`,
      [email]
    );

    if (byEmail) {
      // Sub mismatch — different Google account targeting this email
      if (byEmail.google_id && byEmail.google_id !== googleSub) {
        await logAdminAction(byEmail.id, 'security.google_sub_mismatch', { email, attempted_sub: googleSub }, ip);
        return res.status(409).json({ message: 'Google account conflict — contact support' });
      }

      if (byEmail.is_blocked) {
        await logLoginEvent(byEmail.id, req, false, 'blocked');
        return res.status(403).json({ message: 'Your account has been suspended' });
      }

      // Auto-link: existing email/password user signs in with Google for the first time
      const { rows: [linked] } = await query(
        `UPDATE users
           SET google_id = $1, avatar_url = $2, email_verified = true
         WHERE id = $3
         RETURNING id, email, name, role, is_blocked, totp_enabled,
                   referral_code, store_credit_ghs, loyalty_points, loyalty_tier, loyalty_lifetime_points, avatar_url, email_verified,
                   google_id IS NOT NULL AS has_google,
                   password_hash IS NOT NULL AS has_password`,
        [googleSub, picture ?? byEmail.avatar_url, byEmail.id]
      );
      await logAdminAction(byEmail.id, 'user.google_linked', { email }, ip);
      // Notify user of the new sign-in link
      sendEmail({
        to: linked.email,
        ...emailTemplates.loginAlert({
          name: linked.name,
          device: parseUserAgent(req.headers['user-agent']),
          ip: anonymizeIp(ip),
          time: new Date().toISOString(),
        }),
      }).catch(() => {});
      user = linked;
    } else {
      // New user — create account
      let referralCode;
      for (let attempt = 0; attempt < 5; attempt++) {
        referralCode = generateReferralCode();
        const { rows: clash } = await query('SELECT 1 FROM users WHERE referral_code = $1', [referralCode]);
        if (!clash[0]) break;
        if (attempt === 4) throw new HttpError(500, 'Code generation failed — please try again');
      }

      const { rows: [created] } = await query(
        `INSERT INTO users
           (email, name, password_hash, role, google_id, avatar_url, email_verified, referral_code)
         VALUES ($1, $2, NULL, 'customer', $3, $4, true, $5)
         RETURNING id, email, name, role, is_blocked, totp_enabled,
                   referral_code, store_credit_ghs, loyalty_points, loyalty_tier, loyalty_lifetime_points, avatar_url, email_verified,
                   google_id IS NOT NULL AS has_google,
                   password_hash IS NOT NULL AS has_password`,
        [email, displayName, googleSub, picture ?? null, referralCode]
      );
      await applyReferralIfValid(created.id, email, incomingCode);
      user = created;
    }
  }

  // e) Blocked check after any lookup/create
  if (user.is_blocked) {
    await logLoginEvent(user.id, req, false, 'blocked');
    return res.status(403).json({ message: 'Your account has been suspended' });
  }

  // f) TOTP required
  if (user.totp_enabled) {
    const challengeToken = jwt.sign(
      { sub: user.id, type: 'totp_challenge' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    await logLoginEvent(user.id, req, false, 'totp_pending');
    return res.json({ requires_totp: true, challenge_token: challengeToken });
  }

  // g) Mint tokens
  await logLoginEvent(user.id, req, true, 'google_ok');
  await finishLogin(user, req, res);
  await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  res.json({ user: userPayload(user), requires_totp: false });
}));

// ── POST /api/auth/google/link ────────────────────────────────────────────────

router.post('/google/link', requireAuth, asyncHandler(async (req, res) => {
  const { id_token } = req.body;
  if (!id_token) throw badRequest('id_token is required');

  let gPayload;
  try {
    gPayload = await verifyGoogleIdToken(id_token);
  } catch {
    return res.status(401).json({ message: 'Google sign-in failed' });
  }

  const { sub: googleSub, picture } = gPayload;
  const ip = getIp(req);

  // Check if this google_id is already linked to a different user
  const { rows: [existing] } = await query(
    'SELECT id FROM users WHERE google_id = $1',
    [googleSub]
  );
  if (existing && existing.id !== req.user.id) {
    return res.status(409).json({ message: 'This Google account is already linked to another account' });
  }

  await query(
    'UPDATE users SET google_id = $1, avatar_url = COALESCE($2, avatar_url) WHERE id = $3',
    [googleSub, picture ?? null, req.user.id]
  );
  await logAdminAction(req.user.id, 'user.google_linked', { sub: googleSub }, ip);

  res.json({ message: 'Google account linked' });
}));

// ── DELETE /api/auth/google/link ──────────────────────────────────────────────

router.delete('/google/link', requireAuth, asyncHandler(async (req, res) => {
  const { password } = req.body ?? {};
  const ip = getIp(req);

  const { rows: [u] } = await query(
    'SELECT password_hash FROM users WHERE id = $1',
    [req.user.id]
  );

  if (!u.password_hash) {
    return res.status(400).json({
      message: 'Set a password first so you can still log in after removing Google sign-in.',
    });
  }

  if (!password || !(await bcrypt.compare(password, u.password_hash))) {
    throw unauthorized('Incorrect password');
  }

  await query('UPDATE users SET google_id = NULL WHERE id = $1', [req.user.id]);
  await logAdminAction(req.user.id, 'user.google_unlinked', {}, ip);

  res.json({ message: 'Google sign-in removed' });
}));

// ── POST /api/auth/password/set ───────────────────────────────────────────────

router.post(
  '/password/set',
  requireAuth,
  body('password').isLength({ min: 8 }),
  asyncHandler(async (req, res) => {
    validate(req);
    const { password } = req.body;
    const ip = getIp(req);
    const hash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    await logAdminAction(req.user.id, 'user.password_set', {}, ip);
    res.json({ message: 'Password set' });
  })
);

// ── POST /api/auth/refresh ────────────────────────────────────────────────────

router.post('/refresh', asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) throw unauthorized();
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET); }
  catch { throw unauthorized('Bad refresh token'); }

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const stored = await query(
    'SELECT id FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2 AND expires_at > NOW()',
    [payload.sub, hash]
  );
  if (!stored.rows[0]) throw unauthorized('Refresh token revoked');

  // Check if the matching session has been revoked
  const { rows: [session] } = await query(
    'SELECT id, revoked_at FROM user_sessions WHERE token_hash = $1 AND user_id = $2',
    [hash, payload.sub]
  );
  if (session?.revoked_at) throw unauthorized('Session has been revoked');

  // Rotate
  await query('DELETE FROM refresh_tokens WHERE id = $1', [stored.rows[0].id]);
  const { rows } = await query(
    `SELECT id, email, name, role, referral_code, store_credit_ghs, loyalty_points, loyalty_tier, loyalty_lifetime_points, totp_enabled,
            avatar_url, email_verified,
            google_id IS NOT NULL AS has_google,
            password_hash IS NOT NULL AS has_password
     FROM users WHERE id = $1`,
    [payload.sub]
  );
  const user = rows[0];
  if (!user) throw unauthorized();

  const access = signAccess(user);
  const refresh = signRefresh(user);
  const refreshHash = crypto.createHash('sha256').update(refresh).digest('hex');
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1,$2, NOW() + INTERVAL '7 days')`,
    [user.id, refreshHash]
  );

  // Rotate the session's token_hash to the new refresh token
  if (session?.id) {
    await query(
      'UPDATE user_sessions SET token_hash = $1, last_seen_at = NOW() WHERE id = $2',
      [refreshHash, session.id]
    );
  }

  res
    .cookie('accessToken', access, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 })
    .cookie('refreshToken', refresh, { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 })
    .json({ user: userPayload(user) });
}));

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

router.post('/logout', asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (token) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash]);
    await query(
      'UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1',
      [hash]
    );
  }
  res.clearCookie('accessToken', COOKIE_OPTS).clearCookie('refreshToken', COOKIE_OPTS).json({ ok: true });
}));

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

router.get('/me', requireAuth, viewAsMiddleware, asyncHandler(async (req, res) => {
  const userId = req.viewAs?.user_id ?? req.user.id;
  const { rows: [user] } = await query(
    `SELECT id, email, name, role, is_blocked, referral_code, store_credit_ghs, loyalty_points, loyalty_tier, loyalty_lifetime_points,
            totp_enabled, avatar_url, email_verified,
            google_id IS NOT NULL AS has_google,
            password_hash IS NOT NULL AS has_password
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!user) throw unauthorized();
  res.json({ user: userPayload(user) });
}));

// ── PUT /api/auth/me ──────────────────────────────────────────────────────────

router.put('/me', requireAuth, asyncHandler(async (req, res) => {
  const { name, phone } = req.body ?? {};
  const { rows } = await query(
    `UPDATE users
       SET name  = COALESCE($1, name),
           phone = COALESCE($2, phone),
           updated_at = NOW()
     WHERE id = $3
     RETURNING id, email, name, phone, role, referral_code, store_credit_ghs, loyalty_points, loyalty_tier, loyalty_lifetime_points, totp_enabled,
               avatar_url, email_verified,
               google_id IS NOT NULL AS has_google,
               password_hash IS NOT NULL AS has_password,
               created_at`,
    [name ?? null, phone ?? null, req.user.id]
  );
  res.json({ user: userPayload(rows[0]) });
}));

// ── POST /api/auth/forgot-password ───────────────────────────────────────────

router.post(
  '/forgot-password',
  authLimiter,
  body('email').isEmail().normalizeEmail(),
  asyncHandler(async (req, res) => {
    validate(req);
    const { email } = req.body;
    const { rows } = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (rows[0]) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1,$2, NOW() + INTERVAL '1 hour')`,
        [rows[0].id, `reset:${tokenHash}`]
      );
      const link = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
      const tpl = emailTemplates.passwordReset(link);
      await sendEmail({ to: email, ...tpl });
    }
    res.json({ ok: true });
  })
);

// ── POST /api/auth/reset-password ────────────────────────────────────────────

router.post(
  '/reset-password',
  authLimiter,
  body('token').isString(),
  body('password').isLength({ min: 8 }),
  asyncHandler(async (req, res) => {
    validate(req);
    const { token, password } = req.body;
    const hash = `reset:${crypto.createHash('sha256').update(token).digest('hex')}`;
    const { rows } = await query(
      'SELECT id, user_id FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW()',
      [hash]
    );
    if (!rows[0]) throw new HttpError(400, 'Invalid or expired token');
    const newHash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, rows[0].user_id]);
    await query('DELETE FROM refresh_tokens WHERE id = $1', [rows[0].id]);
    await logAdminAction(rows[0].user_id, 'user.password_set_via_reset', {}, null);
    res.json({ ok: true });
  })
);

// ── TOTP: setup / enable / disable ───────────────────────────────────────────

// POST /api/auth/totp/setup — generate secret + recovery codes; does NOT enable 2FA yet
router.post('/totp/setup', requireAuth, asyncHandler(async (req, res) => {
  const secret = generateSecret();
  const otpauthUrl = generateURI({ label: req.user.email, issuer: 'UrbanPulse', secret, type: 'totp' });
  const qr_data_url = await QRCode.toDataURL(otpauthUrl);

  const plainCodes = generateRecoveryCodes(10);
  const hashedCodes = await Promise.all(plainCodes.map((c) => bcrypt.hash(c, 10)));

  // Store secret + hashed codes immediately; totp_enabled remains false until /enable
  await query(
    'UPDATE users SET totp_secret = $1, totp_recovery_codes = $2 WHERE id = $3',
    [secret, JSON.stringify(hashedCodes), req.user.id]
  );

  // Return plaintext codes ONCE — they are never retrievable again after this response
  res.json({ qr_data_url, recovery_codes: plainCodes });
}));

// POST /api/auth/totp/enable — verify code and flip totp_enabled = true
router.post('/totp/enable', requireAuth, asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code) throw badRequest('code is required');

  const { rows: [u] } = await query(
    'SELECT totp_secret FROM users WHERE id = $1', [req.user.id]
  );
  if (!u?.totp_secret) throw badRequest('Run /totp/setup first');
  if (!verifySync({ token: code, secret: u.totp_secret, window: 1 })?.valid)
    throw badRequest('Invalid verification code');

  await query('UPDATE users SET totp_enabled = true WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
}));

// POST /api/auth/totp/disable — verify password and wipe TOTP data
router.post('/totp/disable', requireAuth, asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password) throw badRequest('password is required');

  const { rows: [u] } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(password, u.password_hash))) throw badRequest('Incorrect password');

  await query(
    'UPDATE users SET totp_secret = NULL, totp_enabled = false, totp_recovery_codes = NULL WHERE id = $1',
    [req.user.id]
  );
  res.json({ ok: true });
}));

// ── Session management ────────────────────────────────────────────────────────

// GET /api/auth/sessions
router.get('/sessions', requireAuth, asyncHandler(async (req, res) => {
  const currentHash = req.cookies?.refreshToken
    ? crypto.createHash('sha256').update(req.cookies.refreshToken).digest('hex')
    : null;

  const { rows } = await query(
    `SELECT id, user_agent, ip_address, last_seen_at, created_at,
            ($2::text IS NOT NULL AND token_hash = $2) AS is_current
     FROM user_sessions
     WHERE user_id = $1 AND revoked_at IS NULL
       AND last_seen_at > NOW() - INTERVAL '30 days'
     ORDER BY last_seen_at DESC`,
    [req.user.id, currentHash]
  );

  res.json(rows.map((s) => ({
    id: s.id,
    device: parseUserAgent(s.user_agent),
    ip_address: anonymizeIp(s.ip_address),
    last_seen_at: s.last_seen_at,
    created_at: s.created_at,
    is_current: s.is_current,
  })));
}));

// DELETE /api/auth/sessions/:id — revoke a specific session
router.delete('/sessions/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [session] } = await query(
    'SELECT token_hash FROM user_sessions WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!session) throw new HttpError(404, 'Session not found');

  await query('UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1', [req.params.id]);
  await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [session.token_hash]);
  res.json({ ok: true });
}));

// POST /api/auth/sessions/revoke-all-others
router.post('/sessions/revoke-all-others', requireAuth, asyncHandler(async (req, res) => {
  const currentHash = req.cookies?.refreshToken
    ? crypto.createHash('sha256').update(req.cookies.refreshToken).digest('hex')
    : null;

  await query(
    `UPDATE user_sessions SET revoked_at = NOW()
     WHERE user_id = $1 AND ($2::text IS NULL OR token_hash != $2) AND revoked_at IS NULL`,
    [req.user.id, currentHash]
  );
  await query(
    'DELETE FROM refresh_tokens WHERE user_id = $1 AND ($2::text IS NULL OR token_hash != $2)',
    [req.user.id, currentHash]
  );
  res.json({ ok: true });
}));

// ── Login history ─────────────────────────────────────────────────────────────

// GET /api/auth/login-history
router.get('/login-history', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, ip_address, user_agent, success, reason, created_at
     FROM login_events
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
     ORDER BY created_at DESC LIMIT 30`,
    [req.user.id]
  );
  res.json(rows.map((r) => ({
    id: r.id,
    device: parseUserAgent(r.user_agent),
    ip_address: anonymizeIp(r.ip_address),
    success: r.success,
    reason: r.reason,
    via_google: r.reason?.startsWith('google') ?? false,
    created_at: r.created_at,
  })));
}));

// ── GET /api/auth/me/data-export ──────────────────────────────────────────────
// Ghana DPA "right to access" — a full, honest export of what UrbanPulse holds about the
// user. Single Promise.all of queries (json_agg for line items, no N+1). No "addresses" key:
// there is no address-book table — the only address history kept is the JSONB snapshot on
// each order's shipping_address, already included under orders[].
router.get('/me/data-export', requireAuth, dataExportLimiter, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const ip = getIp(req);

  const [
    { rows: [user] },
    { rows: orders },
    { rows: returns },
    { rows: wishlist },
    { rows: reviews },
    { rows: referralsGiven },
    { rows: referralsReceived },
    { rows: storeCreditLedger },
    { rows: loyaltyLedger },
    { rows: sessions },
    { rows: loginHistory },
  ] = await Promise.all([
    query(
      `SELECT id, email, name, phone, role, referral_code, store_credit_ghs, loyalty_points,
              loyalty_tier, loyalty_lifetime_points, avatar_url, email_verified,
              google_id IS NOT NULL AS has_google, password_hash IS NOT NULL AS has_password,
              created_at, updated_at
       FROM users WHERE id = $1`,
      [userId]
    ),
    query(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method,
              o.subtotal, o.shipping_cost, o.tax, o.total, o.shipping_address, o.created_at,
              COALESCE((SELECT json_agg(oi ORDER BY oi.id) FROM order_items oi WHERE oi.order_id = o.id), '[]') AS items
       FROM orders o WHERE o.user_id = $1 ORDER BY o.created_at DESC`,
      [userId]
    ),
    query(
      `SELECT r.id, r.order_id, r.rma_number, r.status, r.resolution, r.customer_note, r.created_at,
              COALESCE((SELECT json_agg(ri ORDER BY ri.id) FROM return_items ri WHERE ri.return_id = r.id), '[]') AS items
       FROM returns r WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
      [userId]
    ),
    query(
      `SELECT w.product_id, p.name AS product_name, p.slug, w.created_at AS added_at
       FROM wishlists w JOIN products p ON p.id = w.product_id
       WHERE w.user_id = $1 ORDER BY w.created_at DESC`,
      [userId]
    ),
    query(
      `SELECT r.id, r.product_id, p.name AS product_name, r.rating, r.comment,
              r.verified_purchase, r.image_url, r.created_at
       FROM reviews r JOIN products p ON p.id = r.product_id
       WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
      [userId]
    ),
    query(
      `SELECT id, referred_email, status, referrer_reward_ghs, created_at, qualified_at, rewarded_at
       FROM referrals WHERE referrer_user_id = $1 ORDER BY created_at DESC`,
      [userId]
    ),
    query(
      `SELECT id, status, referred_reward_ghs, created_at, qualified_at, rewarded_at
       FROM referrals WHERE referred_user_id = $1 ORDER BY created_at DESC`,
      [userId]
    ),
    query(`SELECT amount_ghs, reason, related_id, created_at FROM store_credit_ledger WHERE user_id = $1 ORDER BY created_at DESC`, [userId]),
    query(`SELECT delta, reason, related_id, expires_at, note, created_at FROM loyalty_ledger WHERE user_id = $1 ORDER BY created_at DESC`, [userId]),
    query(`SELECT id, user_agent, ip_address, last_seen_at, created_at, revoked_at FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`, [userId]),
    query(`SELECT id, ip_address, user_agent, success, reason, created_at FROM login_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`, [userId]),
  ]);

  if (!user) throw unauthorized();

  const payload = {
    generated_at: new Date().toISOString(),
    profile: user, // no password_hash/totp_secret/totp_recovery_codes/raw google_id — never selected above
    orders,
    returns,
    wishlist,
    reviews,
    referrals: { code: user.referral_code, given: referralsGiven, received: referralsReceived },
    store_credit_ledger: storeCreditLedger,
    loyalty_ledger: loyaltyLedger,
    sessions: sessions.map((s) => ({
      id: s.id,
      device: parseUserAgent(s.user_agent),
      ip_address: anonymizeIp(s.ip_address),
      last_seen_at: s.last_seen_at,
      created_at: s.created_at,
      revoked_at: s.revoked_at,
    })),
    login_history: loginHistory.map((e) => ({
      id: e.id,
      device: parseUserAgent(e.user_agent),
      ip_address: anonymizeIp(e.ip_address),
      success: e.success,
      reason: e.reason,
      created_at: e.created_at,
    })),
  };

  await logAdminAction(userId, 'user.data_export', {}, ip);

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="urbanpulse-data-${userId}-${date}.json"`);
  res.json(payload);
}));

// ── POST /api/auth/me/delete-account ──────────────────────────────────────────
// Ghana DPA "right to erasure" — anonymizes the users row rather than deleting it (orders are
// accounting records with NO ACTION/legally-required retention, so the referenced row must
// keep existing). None of the dependent tables' FK actions fire here since we UPDATE, not
// DELETE, the users row — every cleanup below is an explicit statement for that reason.
router.post('/me/delete-account', requireAuth, ...rejectViewAsWrites, asyncHandler(async (req, res) => {
  const { password } = req.body ?? {};
  const ip = getIp(req);

  if (req.user.role === 'admin') {
    throw badRequest('Admin accounts cannot self-delete. Ask another admin to do this for you.');
  }

  const { rows: [u] } = await query('SELECT name, email, password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!u) throw unauthorized();

  if (!u.password_hash) {
    return res.status(400).json({
      message: 'Set a password first (Account → Security) so you can confirm account deletion.',
      requires_password_setup: true,
    });
  }

  if (!password || !(await bcrypt.compare(password, u.password_hash))) {
    throw unauthorized('Incorrect password');
  }

  const originalEmail = u.email; // captured before anonymization, for the confirmation email below

  await tx(async (c) => {
    await c.query('DELETE FROM customer_notes WHERE customer_id = $1', [req.user.id]);
    await c.query('DELETE FROM customer_flags WHERE customer_id = $1', [req.user.id]);
    await c.query('DELETE FROM wishlists WHERE user_id = $1', [req.user.id]);
    await c.query('DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id = $1)', [req.user.id]);
    await c.query('DELETE FROM carts WHERE user_id = $1', [req.user.id]);
    await c.query('DELETE FROM user_sessions WHERE user_id = $1', [req.user.id]);
    await c.query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]); // also invalidates any pending 'reset:'-prefixed token
    await c.query('DELETE FROM login_events WHERE user_id = $1', [req.user.id]);
    await c.query('UPDATE referrals SET referred_email = NULL WHERE referred_user_id = $1', [req.user.id]);

    // Anonymize the identity LAST — no UPDATE to `reviews` needed; the displayed review
    // author comes from `JOIN users u ON u.id = r.user_id` at read time (products.js),
    // so this propagates "Deleted User" to every review for free.
    await c.query(
      `UPDATE users SET
         name = 'Deleted User',
         email = $2,
         phone = NULL,
         password_hash = NULL,
         totp_secret = NULL,
         totp_enabled = false,
         totp_recovery_codes = NULL,
         google_id = NULL,
         avatar_url = NULL,
         email_verified = false,
         is_blocked = true,
         updated_at = NOW()
       WHERE id = $1`,
      [req.user.id, `deleted-user-${req.user.id}@deleted.urbanpulse.local`]
    );
  });

  await logAdminAction(req.user.id, 'user.account_deleted', {}, ip);
  sendEmail({ to: originalEmail, ...emailTemplates.accountDeleted(u.name) }).catch(() => {});

  res.clearCookie('accessToken', COOKIE_OPTS).clearCookie('refreshToken', COOKIE_OPTS).json({ ok: true, message: 'Account deleted.' });
}));

// ── GET /api/auth/me/privacy-events ───────────────────────────────────────────
// Reuses admin_logs with admin_id = the customer's own id — already the precedent for
// self-service (non-admin-initiated) actions, e.g. user.google_linked is logged this way
// when a customer links their own Google account. No new table.
const PRIVACY_EVENT_ACTIONS = [
  'user.data_export',
  'user.account_deleted',
  'user.consent_updated',
  'user.marketing_unsubscribed',
  'user.google_linked',
  'user.google_unlinked',
  'user.password_set',
  'user.password_set_via_reset',
];

router.get('/me/privacy-events', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT action, details, created_at
     FROM admin_logs
     WHERE admin_id = $1 AND action = ANY($2::text[]) AND created_at > NOW() - INTERVAL '90 days'
     ORDER BY created_at DESC LIMIT 50`,
    [req.user.id, PRIVACY_EVENT_ACTIONS]
  );
  res.json(rows);
}));

// ── POST /api/auth/me/consent-updated ─────────────────────────────────────────
// Audit-trail only — NOT the enforcement mechanism. Cookie/marketing preference enforcement
// is entirely client-side (localStorage); this just records that a change happened, for the
// user's own "Recent privacy events" list.
router.post('/me/consent-updated', requireAuth, ...rejectViewAsWrites, asyncHandler(async (req, res) => {
  const { functional, analytics, marketing } = req.body ?? {};
  await logAdminAction(
    req.user.id, 'user.consent_updated',
    { functional: !!functional, analytics: !!analytics, marketing: !!marketing },
    getIp(req)
  );
  res.json({ ok: true });
}));

// ── Marketing unsubscribe ──────────────────────────────────────────────────────
// NOTE: this does NOT suppress backend/src/jobs/abandonedCart.js — that cron has no per-user
// consent check today, and none is added here (would need a schema change, out of scope this
// sprint). This endpoint records the unsubscribe request and shows a real confirmation page,
// rather than pretending the cron is gated by it.
function signUnsubscribeToken(userId) {
  return jwt.sign({ sub: userId, type: 'marketing_unsubscribe' }, process.env.JWT_SECRET, { expiresIn: '180d' });
}

router.get('/me/unsubscribe-link', requireAuth, asyncHandler(async (req, res) => {
  const token = signUnsubscribeToken(req.user.id);
  res.json({ url: `${process.env.BACKEND_URL || ''}/api/auth/unsubscribe/${token}` });
}));

router.get('/unsubscribe/:token', asyncHandler(async (req, res) => {
  const page = (body) =>
    `<!doctype html><html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#111">${body}</body></html>`;

  let payload;
  try {
    payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
  } catch {
    return res.status(400).send(page('<p>This unsubscribe link is invalid or has expired.</p>'));
  }
  if (payload.type !== 'marketing_unsubscribe') {
    return res.status(400).send(page('<p>Invalid link.</p>'));
  }

  await logAdminAction(payload.sub, 'user.marketing_unsubscribed', { via: 'email_link' }, getIp(req));
  res.send(page('<h2>You&rsquo;re unsubscribed</h2><p>You will no longer receive marketing emails from UrbanPulse.</p>'));
}));

export default router;
