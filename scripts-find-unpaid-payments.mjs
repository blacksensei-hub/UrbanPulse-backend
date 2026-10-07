// Finds orders whose payments went astray before the checkout fixes of
// October 2026 (backend PR #5), and changes nothing:
//
//   1. Paid at Paystack, still "unpaid" here. Opening the payment page twice
//      gave an order a new reference, so a payment made on the first page
//      never reached it. Matched against Paystack's list of successful
//      payments, so earlier references are found too.
//   2. Paid here, but never confirmed. When a customer came back from
//      Paystack before Paystack's own notification, the order was marked
//      paid without its history, email, SMS or referral credit.
//
// Read only: the database is opened in a READ ONLY transaction, so the
// server refuses any write, and Paystack is only asked to list payments.
//
//   node scripts-find-unpaid-payments.mjs            (orders from the last 120 days)
//   node scripts-find-unpaid-payments.mjs --days 365
//
// Reads DATABASE_URL and PAYSTACK_SECRET_KEY from .env.

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const PAYSTACK_API = process.env.PAYSTACK_API_URL || 'https://api.paystack.co';

// A reference this server issued for the order: its order number, or the
// order number with a retry suffix (see src/routes/checkout.js).
const referenceIsFor = (order, reference) =>
  reference === order.order_number || String(reference).startsWith(`${order.order_number}-R`);

/**
 * Pairs unpaid orders with successful Paystack payments. A payment belongs
 * to an order when its reference was issued for that order, or when its
 * metadata names the order. Returns one row per payment found.
 */
export function matchPayments(unpaidOrders, transactions) {
  const found = [];
  for (const order of unpaidOrders) {
    for (const t of transactions) {
      const byReference = referenceIsFor(order, t.reference);
      const byMetadata = Number(t.metadata?.order_id) === Number(order.id);
      if (!byReference && !byMetadata) continue;
      const expected = Math.round(Number(order.total) * 100);
      const paid = Number(t.amount);
      found.push({
        order: order.order_number,
        orderId: order.id,
        placed: order.created_at,
        total: Number(order.total),
        paystackReference: t.reference,
        paidGhs: paid / 100,
        paidAt: t.paid_at,
        matchedBy: byReference ? 'reference' : 'metadata only: check by hand',
        covers: t.currency === 'GHS' && paid >= expected ? 'yes' : `NO: ${t.currency} ${paid / 100}`,
      });
    }
  }
  return found;
}

async function listSuccessfulPayments(fromIso) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const url = `${PAYSTACK_API}/transaction?status=success&perPage=100&page=${page}&from=${encodeURIComponent(fromIso)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
    const body = await res.json();
    if (!res.ok || !body.status) throw new Error(`Paystack list failed: ${body?.message ?? res.status}`);
    out.push(...body.data);
    if (page >= Number(body.meta?.pageCount ?? 1)) return out;
  }
}

async function main() {
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 120;
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days needs a positive number');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!process.env.PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not set');

  const since = new Date(Date.now() - days * 86_400_000);
  const host = new URL(process.env.DATABASE_URL).hostname;
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  await db.connect();

  let unpaid;
  let unconfirmed;
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    ({ rows: unpaid } = await db.query(
      `SELECT id, order_number, total, created_at
         FROM orders
        WHERE payment_method = 'paystack' AND payment_status <> 'paid' AND created_at >= $1
        ORDER BY created_at`,
      [since],
    ));
    ({ rows: unconfirmed } = await db.query(
      `SELECT o.order_number AS order, o.id AS "orderId", o.created_at AS placed, o.total::float AS total,
              COALESCE(o.email, o.shipping_address->>'email') AS email
         FROM orders o
        WHERE o.payment_method = 'paystack' AND o.payment_status = 'paid' AND o.created_at >= $1
          AND NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND h.status = 'paid')
        ORDER BY o.created_at`,
      [since],
    ));
    await db.query('ROLLBACK');
  } finally {
    await db.end();
  }

  console.log(`Paystack orders placed since ${since.toISOString().slice(0, 10)} (last ${days} days)\n`);

  console.log(`1. Paid at Paystack, still unpaid here (${unpaid.length} unpaid orders checked)`);
  const found = unpaid.length ? matchPayments(unpaid, await listSuccessfulPayments(since.toISOString())) : [];
  if (found.length) console.table(found);
  else console.log('   None found.');

  console.log(`\n2. Paid, but never confirmed: likely no confirmation email or SMS (${unconfirmed.length})`);
  if (unconfirmed.length) console.table(unconfirmed);
  else console.log('   None found.');

  console.log('\nNothing was changed.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
