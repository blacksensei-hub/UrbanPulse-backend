import express from 'express';
import { query, tx } from '../db/index.js';
import { asyncHandler, badRequest, notFound } from '../utils/helpers.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { adminLimiter } from '../utils/rateLimiter.js';
import { logAdminAction } from '../utils/adminLog.js';
import { isMissingTable } from '../utils/stockAlerts.js';
import { ghanaPhone } from '../utils/phone.js';
import { welcomeOffer, sendDrop, sendBatch, dropProduct } from '../utils/drops.js';

// Admin → Drop list. Mounted at /api/admin/drops, ahead of the main admin router.
const router = express.Router();
router.use(adminLimiter, requireAuth, requireAdmin);

// What the admin wrote, reduced to something safe to send.
function draftFrom(body) {
  const channels = [...new Set((Array.isArray(body?.channels) ? body.channels : [])
    .filter((c) => c === 'email' || c === 'sms'))];
  const message = String(body?.message ?? '').trim().slice(0, 2000);
  const subject = String(body?.subject ?? '').trim().slice(0, 150);
  if (!channels.length) throw badRequest('Choose email, text message or both.');
  if (!message) throw badRequest('Write the message first.');
  if (channels.includes('email') && !subject) throw badRequest('Add a subject line for the email.');
  return { channels, message, subject: subject || message.slice(0, 80), product_id: Number(body?.product_id) || null };
}

router.get('/', asyncHandler(async (_req, res) => {
  try {
    const [counts, recent, broadcasts] = await Promise.all([
      query(`SELECT COUNT(*) FILTER (WHERE channel = 'email' AND unsubscribed_at IS NULL)::int AS email,
                    COUNT(*) FILTER (WHERE channel = 'sms'   AND unsubscribed_at IS NULL)::int AS sms,
                    COUNT(*) FILTER (WHERE unsubscribed_at IS NULL AND created_at > NOW() - INTERVAL '7 days')::int AS joined_7d,
                    COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed
               FROM drop_subscribers`),
      query(`SELECT id, channel, address, source, created_at, unsubscribed_at
               FROM drop_subscribers ORDER BY created_at DESC LIMIT 30`),
      query(`SELECT b.id, b.subject, b.channels, b.total, b.sent, b.failed, b.created_at, b.finished_at,
                    p.name AS product_name,
                    (SELECT COUNT(*)::int FROM drop_deliveries d
                      WHERE d.broadcast_id = b.id AND d.status IN ('pending', 'sending')) AS remaining
               FROM drop_broadcasts b LEFT JOIN products p ON p.id = b.product_id
              ORDER BY b.created_at DESC LIMIT 20`),
    ]);
    const { rows: [w] } = await query(`SELECT value FROM site_settings WHERE key = 'drop_welcome_coupon'`);
    res.json({
      enabled: true,
      counts: counts.rows[0],
      recent: recent.rows,
      broadcasts: broadcasts.rows,
      welcome_code: String(w?.value ?? ''),
      offer: await welcomeOffer(),
      // So the page can say plainly when a channel would only be logged.
      email_ready: !!process.env.SMTP_HOST,
      sms_ready: !!process.env.SMS_API_KEY,
    });
  } catch (err) {
    if (isMissingTable(err)) return res.json({ enabled: false });
    throw err;
  }
}));

// PUT /welcome { code }: the coupon shown on the sign-up forms ('' for none).
router.put('/welcome', asyncHandler(async (req, res) => {
  const code = String(req.body?.code ?? '').trim();
  if (code) {
    const { rows: [c] } = await query('SELECT is_active FROM coupons WHERE UPPER(code) = UPPER($1)', [code]);
    if (!c) throw badRequest('There is no coupon with that code.');
    if (!c.is_active) throw badRequest('That coupon is switched off. Turn it on in Coupons first.');
  }
  await query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ('drop_welcome_coupon', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(code)],
  );
  await logAdminAction(req.user.id, 'drops.welcome_offer', { code: code || null }, req.ip);
  res.json({ ok: true, welcome_code: code, offer: await welcomeOffer() });
}));

// POST /test: the same message, sent only to the admin (email) and/or the
// phone number they give.
router.post('/test', asyncHandler(async (req, res) => {
  const draft = draftFrom(req.body);
  const product = await dropProduct(draft.product_id);
  const sentTo = [];
  const token = 'testmessage';   // same length as a real token, so the text counts true
  try {
    if (draft.channels.includes('email')) {
      await sendDrop({ channel: 'email', address: req.user.email, token }, draft, product);
      sentTo.push(req.user.email);
    }
    if (draft.channels.includes('sms')) {
      const phone = ghanaPhone(req.body?.test_phone);
      if (!phone) throw badRequest('Add your phone number to get the test text.');
      await sendDrop({ channel: 'sms', address: phone, token }, draft, product);
      sentTo.push(`+${phone}`);
    }
  } catch (err) {
    if (err.status) throw err;
    return res.status(502).json({ error: `The test didn't send: ${err.message}`, sent_to: sentTo });
  }
  res.json({ ok: true, sent_to: sentTo });
}));

// POST /broadcasts: fix the recipient list and start. Nothing is sent here;
// the page then calls /broadcasts/:id/send until it's done.
router.post('/broadcasts', asyncHandler(async (req, res) => {
  const draft = draftFrom(req.body);
  if (draft.product_id && !(await dropProduct(draft.product_id))) throw badRequest('That product is hidden or gone.');

  // A double-click, or pressing Send again after a timeout, reuses the send
  // just started instead of messaging everyone twice.
  const { rows: [dupe] } = await query(
    `SELECT id, total FROM drop_broadcasts
      WHERE message = $1 AND subject = $2 AND channels = $3::text[] AND created_at > NOW() - INTERVAL '10 minutes'
      ORDER BY id DESC LIMIT 1`,
    [draft.message, draft.subject, draft.channels],
  );
  if (dupe) return res.json({ id: dupe.id, total: dupe.total, reused: true });

  const result = await tx(async (client) => {
    const { rows: [b] } = await client.query(
      `INSERT INTO drop_broadcasts (subject, message, product_id, channels, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [draft.subject, draft.message, draft.product_id, draft.channels, req.user.id],
    );
    const { rowCount } = await client.query(
      `INSERT INTO drop_deliveries (broadcast_id, subscriber_id)
       SELECT $1, id FROM drop_subscribers WHERE unsubscribed_at IS NULL AND channel = ANY($2::text[])`,
      [b.id, draft.channels],
    );
    if (!rowCount) throw badRequest('Nobody is on the list for that yet.');
    await client.query('UPDATE drop_broadcasts SET total = $2 WHERE id = $1', [b.id, rowCount]);
    return { id: b.id, total: rowCount };
  });
  await logAdminAction(req.user.id, 'drops.broadcast', { id: result.id, total: result.total, channels: draft.channels }, req.ip);
  res.status(201).json(result);
}));

// POST /broadcasts/:id/send: send the next few; returns what's left.
router.post('/broadcasts/:id(\\d+)/send', asyncHandler(async (req, res) => {
  const r = await sendBatch(Number(req.params.id));
  if (!r) throw notFound('That send was not found.');
  res.json(r);
}));

// POST /broadcasts/:id/retry: try the failed ones again.
router.post('/broadcasts/:id(\\d+)/retry', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { rowCount } = await query(
    `UPDATE drop_deliveries SET status = 'pending', error = NULL WHERE broadcast_id = $1 AND status = 'failed'`, [id],
  );
  await query('UPDATE drop_broadcasts SET finished_at = NULL WHERE id = $1 AND $2::int > 0', [id, rowCount]);
  res.json({ ok: true, retrying: rowCount });
}));

// POST /subscribers/:id/remove: take someone off the list (they asked).
router.post('/subscribers/:id(\\d+)/remove', asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    'UPDATE drop_subscribers SET unsubscribed_at = COALESCE(unsubscribed_at, NOW()) WHERE id = $1', [Number(req.params.id)],
  );
  if (!rowCount) throw notFound();
  await logAdminAction(req.user.id, 'drops.remove_subscriber', { id: Number(req.params.id) }, req.ip);
  res.json({ ok: true });
}));

export default router;
