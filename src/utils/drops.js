import crypto from 'node:crypto';
import { query } from '../db/index.js';
import { sendEmail, emailTemplates, markdownToText } from './email.js';
import { sendSMS, smsTemplates } from './sms.js';
import { logger } from './logger.js';

export const siteUrl = () => (process.env.FRONTEND_URL || 'https://urbanpulsee.vercel.app').replace(/\/$/, '');
export const newToken = () => crypto.randomBytes(8).toString('base64url');   // 11 characters
export const stopUrl = (token) => `${siteUrl()}/stop/${token}`;

// Where a drop message sends people. Texts get the short /d/ link (that page
// adds the tracking tags), emails the full one, so visits from each show up
// under their own source in Admin → Analytics → Visitors.
export function dropLinks(product) {
  const tags = (source) => `utm_source=${source}&utm_medium=drop&utm_campaign=drop`;
  const path = product ? `/products/${product.slug}` : '/shop';
  return {
    email: `${siteUrl()}${path}?${tags('email')}`,
    sms: `${siteUrl()}/d${product ? `/${product.slug}` : ''}`,
  };
}

const money = (n) => `GH₵ ${Number(n) % 1 ? Number(n).toFixed(2) : Number(n)}`;

/**
 * The welcome offer on the sign-up forms: the coupon chosen in Admin → Drop
 * list, described from the coupon itself so the promise always matches what
 * checkout gives. null when none is chosen or the coupon can't be used now.
 * Read straight from the database, not the per-instance settings cache, so
 * a change shows everywhere at once.
 */
export async function welcomeOffer() {
  const { rows: [s] } = await query(`SELECT value FROM site_settings WHERE key = 'drop_welcome_coupon'`);
  const code = String(s?.value ?? '').trim();
  if (!code) return null;
  const { rows: [c] } = await query(
    `SELECT code, type, value, min_order_amount, first_order_only, is_active,
            valid_from, valid_until, starts_at, usage_limit, used_count
       FROM coupons WHERE UPPER(code) = UPPER($1)`,
    [code],
  );
  if (!c || !c.is_active) return null;
  const now = new Date();
  if ([c.starts_at, c.valid_from].some((d) => d && new Date(d) > now)) return null;
  if (c.valid_until && new Date(c.valid_until) < now) return null;
  if (c.usage_limit && c.used_count >= c.usage_limit) return null;
  const which = c.first_order_only ? 'your first order' : 'your next order';
  const label = {
    percentage: `${Number(c.value)}% off ${which}`,
    fixed: `${money(c.value)} off ${which}`,
    free_shipping: `Free delivery on ${which}`,
  }[c.type];
  if (!label) return null;
  const min = Number(c.min_order_amount || 0);
  return { code: c.code, label, note: min > 0 ? `On orders over ${money(min)}.` : null };
}

// One announcement to one contact. Throws if the provider refuses it.
export async function sendDrop(sub, draft, product) {
  const links = dropLinks(product);
  if (sub.channel === 'email') {
    const mail = emailTemplates.drop({
      subject: draft.subject,
      message: draft.message,
      product: product && { name: product.name, price: product.price, image: product.images?.[0] },
      url: links.email,
      unsubscribeUrl: stopUrl(sub.token),
    });
    await sendEmail({
      to: sub.address,
      ...mail,
      // Lets mail apps show their own "Unsubscribe" button (one click, RFC 8058).
      headers: {
        'List-Unsubscribe': `<${siteUrl()}/api/drops/stop/${sub.token}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  } else {
    await sendSMS({
      to: sub.address,
      message: smsTemplates.drop({ message: markdownToText(draft.message), url: links.sms, stopUrl: stopUrl(sub.token) }),
    });
  }
}

export async function dropProduct(id) {
  if (!id) return null;
  const { rows: [p] } = await query(
    'SELECT id, slug, name, price, images FROM products WHERE id = $1 AND is_active = true', [id],
  );
  return p ?? null;
}

/**
 * Send the next few messages of an announcement. The admin page calls this
 * repeatedly until nothing is left, so no single request runs long, and a
 * send interrupted by a closed tab or a restart picks up where it stopped.
 * Messages claimed by a request that died are retried after 5 minutes.
 */
export async function sendBatch(broadcastId, size = 6) {
  const { rows: [b] } = await query('SELECT * FROM drop_broadcasts WHERE id = $1', [broadcastId]);
  if (!b) return null;
  const product = await dropProduct(b.product_id);

  const { rows: claimed } = await query(
    `UPDATE drop_deliveries d SET status = 'sending', claimed_at = NOW()
       FROM drop_subscribers s
      WHERE s.id = d.subscriber_id
        AND (d.broadcast_id, d.subscriber_id) IN (
          SELECT broadcast_id, subscriber_id FROM drop_deliveries
           WHERE broadcast_id = $1
             AND (status = 'pending' OR (status = 'sending' AND claimed_at < NOW() - INTERVAL '5 minutes'))
           ORDER BY subscriber_id
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
      RETURNING d.subscriber_id, s.channel, s.address, s.token, s.unsubscribed_at`,
    [broadcastId, size],
  );

  const mark = (subscriberId, status, error = null) => query(
    `UPDATE drop_deliveries SET status = $3, error = $4, sent_at = CASE WHEN $3 = 'sent' THEN NOW() ELSE sent_at END
      WHERE broadcast_id = $1 AND subscriber_id = $2`,
    [broadcastId, subscriberId, status, error],
  );
  await Promise.all(claimed.map(async (sub) => {
    if (sub.unsubscribed_at) return mark(sub.subscriber_id, 'skipped');   // left the list since
    try {
      await sendDrop(sub, b, product);
      await mark(sub.subscriber_id, 'sent');
    } catch (err) {
      logger.error('drop message failed', { broadcastId, subscriberId: sub.subscriber_id, channel: sub.channel, err: err.message });
      await mark(sub.subscriber_id, 'failed', String(err.message).slice(0, 300));
    }
  }));

  const { rows: [n] } = await query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS remaining,
            COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM drop_deliveries WHERE broadcast_id = $1`,
    [broadcastId],
  );
  await query(
    `UPDATE drop_broadcasts SET sent = $2, failed = $3,
            finished_at = CASE WHEN $4::int = 0 THEN COALESCE(finished_at, NOW()) ELSE NULL END
      WHERE id = $1`,
    [broadcastId, n.sent, n.failed, n.remaining],
  );
  return { id: b.id, total: b.total, ...n };
}
