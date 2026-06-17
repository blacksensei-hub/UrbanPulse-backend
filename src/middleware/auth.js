import jwt from 'jsonwebtoken';
import { query } from '../db/index.js';
import { unauthorized, forbidden } from '../utils/helpers.js';

const verify = (token, secret) =>
  new Promise((resolve, reject) =>
    jwt.verify(token, secret, (err, payload) => (err ? reject(err) : resolve(payload)))
  );

async function loadUser(req) {
  const token = req.cookies?.accessToken || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const payload = await verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      'SELECT id, email, name, role, is_blocked, referral_code, store_credit_ghs, totp_enabled FROM users WHERE id = $1',
      [payload.sub]
    );
    if (!rows[0] || rows[0].is_blocked) return null;
    return rows[0];
  } catch {
    return null;
  }
}

export const requireAuth = async (req, _res, next) => {
  const user = await loadUser(req);
  if (!user) return next(unauthorized('Please sign in'));
  req.user = user;
  next();
};

export const optionalAuth = async (req, _res, next) => {
  req.user = await loadUser(req);
  next();
};

export const requireAdmin = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('Admin access required'));
  next();
};

export function signAccess(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });
}
export function signRefresh(user) {
  return jwt.sign({ sub: user.id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  });
}

export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

export const viewAsMiddleware = async (req, _res, next) => {
  const token = req.headers['x-view-as-token'];
  if (!token) return next();
  try {
    const payload = await verify(token, process.env.JWT_SECRET);
    if (payload.mode === 'view-as') {
      req.viewAs = { user_id: payload.impersonating_user_id, admin_id: payload.admin_id };
    }
  } catch {
    // expired or invalid — silently ignore
  }
  next();
};

export const rejectViewAsWrites = [
  viewAsMiddleware,
  (req, _res, next) => {
    if (req.viewAs) return next(forbidden('Writes are not allowed in view-as mode'));
    next();
  },
];
