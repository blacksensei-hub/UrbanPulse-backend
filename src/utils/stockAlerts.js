import { query } from '../db/index.js';
import { sendEmail, emailTemplates } from './email.js';
import { sendSMS, smsTemplates } from './sms.js';
import { logger } from './logger.js';

const frontendUrl = () => (process.env.FRONTEND_URL || 'https://urbanpulsee.vercel.app').replace(/\/$/, '');

// Postgres "relation does not exist": the migration hasn't been run yet.
export const isMissingTable = (err) => err?.code === '42P01' || err?.code === '42703';

/**
 * Tell everyone waiting on a size that has come back into stock, once.
 *
 * Runs after any successful admin write (see the hook in routes/admin.js)
 * rather than inside each of the ~10 places stock can change (edits,
 * adjustments, CSV import, return restocks, pre-order release), so no path
 * can be missed. It's one indexed query when nobody is waiting.
 *
 * An alert is marked notified only when at least one channel succeeded, so a
 * failed send is retried on the next restock check instead of being lost.
 */
export async function notifyBackInStock({ limit = 100 } = {}) {
  let rows;
  try {
    ({ rows } = await query(
      `SELECT a.id, a.email, a.phone, p.name, p.slug, p.images, pv.size, pv.color
         FROM stock_alerts a
         JOIN product_variants pv ON pv.id = a.variant_id
         JOIN products p ON p.id = a.product_id
        WHERE a.notified_at IS NULL AND pv.stock > 0 AND p.is_active = true
        ORDER BY a.created_at
        LIMIT $1`,
      [limit],
    ));
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
  if (!rows.length) return 0;

  const sent = [];
  await Promise.allSettled(rows.map(async (a) => {
    const payload = { productName: a.name, slug: a.slug, size: a.size, color: a.color, image: a.images?.[0] };
    let ok = false;
    if (a.email) {
      try { await sendEmail({ to: a.email, ...emailTemplates.backInStock(payload) }); ok = true; }
      catch (err) { logger.error('back-in-stock email failed', { alertId: a.id, err: err.message }); }
    }
    if (a.phone) {
      try {
        await sendSMS({ to: a.phone, message: smsTemplates.backInStock({ productName: a.name, size: a.size, url: `${frontendUrl()}/products/${a.slug}` }) });
        ok = true;
      } catch (err) { logger.error('back-in-stock SMS failed', { alertId: a.id, err: err.message }); }
    }
    if (ok) sent.push(a.id);
  }));
  if (sent.length) await query('UPDATE stock_alerts SET notified_at = NOW() WHERE id = ANY($1::int[])', [sent]);
  logger.info('back-in-stock notifications sent', { count: sent.length });
  return sent.length;
}
