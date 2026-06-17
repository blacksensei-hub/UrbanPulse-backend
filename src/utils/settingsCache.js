import { query } from '../db/index.js';

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
    } catch { /* fail open on cache errors */ }
    next();
  };
}
