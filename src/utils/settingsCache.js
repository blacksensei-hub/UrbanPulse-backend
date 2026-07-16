import { query } from '../db/index.js';
import { logger } from './logger.js';

let cache = null;

export async function getSettings() {
  if (cache) return cache;
  const { rows } = await query('SELECT key, value FROM site_settings');
  cache = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return cache;
}

export function invalidateSettings() {
  cache = null;
}

export function requireFeature(key) {
  return async (req, res, next) => {
    try {
      const s = await getSettings();
      if (s[key] === 'false' || s[key] === false) {
        return res.status(503).json({ error: 'This feature is currently disabled' });
      }
    } catch (err) {
      // Fail open — a broken settings cache shouldn't block requests — but
      // still surface it, since it's a real operational problem either way.
      logger.error('requireFeature settings check failed', { key, err: err.message });
    }
    next();
  };
}
