// test/order-expiry.test.js
//
// Orders left unpaid for 2 hours, and payments that arrive after that, through
// the real routes and a real (throwaway) database. The scheduled job is run
// the way the workflow runs it, through POST /api/cron/expire-orders. Paystack
// is a stand-in that knows each payment's state (abandoned, in progress,
// paid), can be made unreachable, and records refunds.

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createTestDatabase, dropTestDatabase, skipReason } from './support/testdb.js';

// false, not null: node:test treats `skip: null` as "skip".
const skip = skipReason() || false;
const DB_NAME = `urbanpulse_test_expiry_${process.pid}`;
const SECRET = 'sk_test_local_only';
const CRON = 'cron-secret-for-tests';

// Set before the app loads: no .env file, no mail or SMS, test keys.
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: 'test/support/no-such.env',
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-only-jwt-secret',
  PAYSTACK_SECRET_KEY: SECRET,
  CRON_SECRET: CRON,
  SMTP_HOST: '',
  SMS_API_KEY: '',
  SENTRY_DSN: '',
  FRONTEND_URL: 'http://localhost:5173',
});

// ── Paystack stand-in ────────────────────────────────────────────────
const paystack = { tx: new Map(), refunds: [], down: false };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.paystack.co/transaction/initialize')) {
    const body = JSON.parse(options.body);
    paystack.tx.set(body.reference, { reference: body.reference, status: 'abandoned', currency: 'GHS', amount: body.amount, metadata: body.metadata });
    return Response.json({ status: true, data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, access_code: 'ac', reference: body.reference } });
  }
  if (u.startsWith('https://api.paystack.co/transaction/verify/')) {
    if (paystack.down) return Response.json({ status: false, message: 'Service unavailable' }, { status: 503 });
    const data = paystack.tx.get(decodeURIComponent(u.split('/').pop()));
    return data
      ? Response.json({ status: true, data })
      : Response.json({ status: false, message: 'Transaction reference not found' }, { status: 404 });
  }
  if (u === 'https://api.paystack.co/refund') {
    const body = JSON.parse(options.body);
    await new Promise((resolve) => setTimeout(resolve, 60));
    paystack.refunds.push({ transaction: body.transaction, amount: body.amount });
    return Response.json({ status: true, data: { amount: body.amount, status: 'pending' } });
  }
  const { hostname } = new URL(u);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') throw new Error(`Unexpected outside call: ${u}`);
  return realFetch(url, options);
};

let server;
let base;
let db;
let signAccess;
let invalidateSettings;
let adminToken;

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = await createTestDatabase(DB_NAME);

  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  ({ pool: db } = await import('../src/db/index.js'));
  ({ signAccess } = await import('../src/middleware/auth.js'));
  ({ invalidateSettings } = await import('../src/utils/settingsCache.js'));
  const { errorHandler } = await import('../src/middleware/errorHandler.js');

  // Mounted as in server.js: the webhook gets the raw body it signs.
  const app = express();
  app.use(cookieParser());
  app.use('/api/webhooks', express.raw({ type: 'application/json' }), (await import('../src/routes/webhooks.js')).default);
  app.use(express.json());
  app.use('/api/orders', (await import('../src/routes/orders.js')).default);
  app.use('/api/checkout', (await import('../src/routes/checkout.js')).default);
  app.use('/api/admin', (await import('../src/routes/admin.js')).default);
  app.use('/api/cron', (await import('../src/routes/cron.js')).default);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const { rows: [admin] } = await db.query(
    "INSERT INTO users (email, name, role) VALUES ('expiry-admin@example.test', 'Expiry Admin', 'admin') RETURNING id, role",
  );
  adminToken = signAccess(admin);
});

after(async () => {
  if (skip) return;
  server?.close();
  await db?.end();
  await dropTestDatabase(DB_NAME);
});

// ── Fixtures ─────────────────────────────────────────────────────────
let seq = 0;
const money = (v) => Number(v);
const address = { name: 'Ama Mensah', line1: '12 Oxford St', city: 'Accra', state: 'Greater Accra', phone: '0244000000' };

async function product({ price = 200, stock = 5 } = {}) {
  seq += 1;
  const { rows: [p] } = await db.query('INSERT INTO products (slug, name, price) VALUES ($1, $2, $3) RETURNING id', [`expiry-item-${seq}`, `Expiry item ${seq}`, price]);
  const { rows: [v] } = await db.query("INSERT INTO product_variants (product_id, size, color, stock) VALUES ($1, 'M', 'Black', $2) RETURNING id", [p.id, stock]);
  return v.id;
}

async function customer({ credit = 0 } = {}) {
  seq += 1;
  const { rows: [u] } = await db.query(
    'INSERT INTO users (email, name, store_credit_ghs) VALUES ($1, $2, $3) RETURNING id, role, email',
    [`expiry${seq}@example.test`, `Customer ${seq}`, credit],
  );
  return { id: u.id, email: u.email, token: signAccess(u) };
}

async function coupon() {
  seq += 1;
  const code = `EXPIRY${seq}`;
  await db.query("INSERT INTO coupons (code, type, value, usage_limit) VALUES ($1, 'fixed', 20, 10)", [code]);
  return code;
}

// Places an order from a fresh cart; with `pay`, also opens the payment page.
async function placeOrder({ variantId, qty = 2, user, body = {}, pay = true }) {
  seq += 1;
  const session = `expiry-session-${seq}-${process.pid}`;
  const { rows: [c] } = await db.query('INSERT INTO carts (session_id, user_id) VALUES ($1, $2) RETURNING id', [user ? null : session, user?.id ?? null]);
  await db.query('INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, $3)', [c.id, variantId, qty]);
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${user.token}`;
  else headers['x-session-id'] = session;
  const res = await fetch(`${base}/api/orders`, {
    method: 'POST', headers,
    body: JSON.stringify({ shipping_address: address, email: user?.email ?? 'guest@example.test', ...body }),
  });
  const order = await res.json();
  assert.equal(res.status, 201, JSON.stringify(order));
  let reference = null;
  if (pay) {
    const start = await fetch(`${base}/api/checkout/session`, { method: 'POST', headers, body: JSON.stringify({ order_id: order.id }) });
    ({ reference } = await start.json());
  }
  return { order, reference, headers };
}

const hoursAgo = (orderId, hours) => db.query(`UPDATE orders SET created_at = created_at - make_interval(hours => $1) WHERE id = $2`, [hours, orderId]);

async function runExpiry(auth = `Bearer ${CRON}`) {
  const res = await fetch(`${base}/api/cron/expire-orders`, { method: 'POST', headers: auth ? { authorization: auth } : {} });
  return { status: res.status, body: await res.json() };
}

// Paystack reports the payment as paid, and its webhook arrives.
async function paidOnPaystack(reference, orderId, total) {
  const charge = { reference, status: 'success', currency: 'GHS', amount: Math.round(money(total) * 100), metadata: { order_id: orderId } };
  paystack.tx.set(reference, charge);
  const raw = JSON.stringify({ event: 'charge.success', data: charge });
  const res = await fetch(`${base}/api/webhooks/paystack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': crypto.createHmac('sha512', SECRET).update(raw).digest('hex') },
    body: raw,
  });
  assert.equal(res.status, 200);
}

const orderRow = async (id) => (await db.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
const stockOf = async (id) => (await db.query('SELECT stock FROM product_variants WHERE id = $1', [id])).rows[0].stock;
const creditOf = async (id) => money((await db.query('SELECT store_credit_ghs FROM users WHERE id = $1', [id])).rows[0].store_credit_ghs);
const usedCount = async (code) => (await db.query('SELECT used_count FROM coupons WHERE code = $1', [code])).rows[0].used_count;
const lastNote = async (id) => (await db.query('SELECT status, note FROM order_status_history WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [id])).rows[0];

beforeEach(async () => {
  if (skip) return;
  paystack.tx.clear();
  paystack.refunds.length = 0;
  paystack.down = false;
  // Only this test's orders count: earlier tests' leftovers are closed off.
  await db.query(`UPDATE orders SET status = 'cancelled' WHERE status NOT IN ('cancelled', 'refunded') AND payment_status <> 'paid'`);
  await db.query('DELETE FROM site_settings');
  for (const [key, value] of Object.entries({ tax_rate_percent: 12.5, shipping_standard_ghs: 30, free_shipping_threshold_ghs: 1000 })) {
    await db.query('INSERT INTO site_settings (key, value) VALUES ($1, $2::jsonb)', [key, JSON.stringify(value)]);
  }
  invalidateSettings();
});

// ── Releasing unpaid orders ──────────────────────────────────────────
describe('releasing orders left unpaid for 2 hours', { skip }, () => {
  test('gives back the stock, the store credit and the coupon use', async () => {
    const user = await customer({ credit: 50 });
    const variantId = await product({ stock: 5 });
    const code = await coupon();
    const { order } = await placeOrder({ variantId, user, body: { coupon_code: code, apply_store_credit_ghs: 50 } });
    assert.deepEqual([await stockOf(variantId), await creditOf(user.id), await usedCount(code)], [3, 0, 1]);
    await hoursAgo(order.id, 3);

    const run = await runExpiry();
    assert.equal(run.status, 200);
    assert.equal(run.body.expired, 1);
    assert.equal((await orderRow(order.id)).status, 'cancelled');
    assert.match((await lastNote(order.id)).note, /Not paid within 2 hours/);
    assert.deepEqual([await stockOf(variantId), await creditOf(user.id), await usedCount(code)], [5, 50, 0]);
  });

  test('leaves alone a newer order, a paid one and a cash-on-delivery one', async () => {
    const variantId = await product({ stock: 10 });
    const recent = await placeOrder({ variantId });
    const paid = await placeOrder({ variantId });
    await paidOnPaystack(paid.reference, paid.order.id, paid.order.total);
    const cod = await placeOrder({ variantId, body: { payment_method: 'cod' }, pay: false });
    await hoursAgo(paid.order.id, 3);
    await hoursAgo(cod.order.id, 3);

    assert.equal((await runExpiry()).body.expired, 0);
    assert.equal((await orderRow(recent.order.id)).status, 'pending');
    assert.equal((await orderRow(paid.order.id)).payment_status, 'paid');
    assert.equal((await orderRow(cod.order.id)).status, 'awaiting_confirmation');
    assert.equal(await stockOf(variantId), 4);
  });

  test('releases an order whose payment page was never opened', async () => {
    const variantId = await product({ stock: 5 });
    const { order } = await placeOrder({ variantId, pay: false });
    await hoursAgo(order.id, 3);
    assert.equal((await runExpiry()).body.expired, 1);
    assert.equal(await stockOf(variantId), 5);
  });

  test('confirms instead an order that was paid but whose notification never came', async () => {
    const variantId = await product({ stock: 5 });
    const { order, reference } = await placeOrder({ variantId });
    paystack.tx.set(reference, { ...paystack.tx.get(reference), status: 'success', amount: Math.round(money(order.total) * 100) });
    await hoursAgo(order.id, 3);

    const run = await runExpiry();
    assert.deepEqual([run.body.confirmed, run.body.expired], [1, 0]);
    const row = await orderRow(order.id);
    assert.deepEqual([row.payment_status, row.status], ['paid', 'processing']);
    assert.equal(await stockOf(variantId), 3);
  });

  test('leaves an order that is still being paid for the next run', async () => {
    const variantId = await product({ stock: 5 });
    const { order, reference } = await placeOrder({ variantId });
    paystack.tx.get(reference).status = 'ongoing';
    await hoursAgo(order.id, 3);

    assert.deepEqual([(await runExpiry()).body.stillPaying, (await orderRow(order.id)).status], [1, 'pending']);
    assert.equal(await stockOf(variantId), 3);
  });

  test("releases nothing when Paystack can't be asked", async () => {
    const variantId = await product({ stock: 5 });
    const { order } = await placeOrder({ variantId });
    await hoursAgo(order.id, 3);
    paystack.down = true;

    assert.deepEqual([(await runExpiry()).body.unchecked, (await orderRow(order.id)).status], [1, 'pending']);
    assert.equal(await stockOf(variantId), 3);
  });

  test('running twice releases once', async () => {
    const variantId = await product({ stock: 5 });
    const { order } = await placeOrder({ variantId });
    await hoursAgo(order.id, 3);
    await Promise.all([runExpiry(), runExpiry()]);
    assert.equal(await stockOf(variantId), 5);
  });

  test("an expired order can't start a new payment", async () => {
    const variantId = await product({ stock: 5 });
    const { order, headers } = await placeOrder({ variantId });
    await hoursAgo(order.id, 3);
    await runExpiry();
    const res = await fetch(`${base}/api/checkout/session`, { method: 'POST', headers, body: JSON.stringify({ order_id: order.id }) });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(await res.json()), /expired/);
  });
});

// ── Payments that arrive after the release ───────────────────────────
describe('a payment that arrives after the order was released', { skip }, () => {
  async function expiredOrder({ credit = 0, stock = 5 } = {}) {
    const user = await customer({ credit });
    const variantId = await product({ stock });
    const code = await coupon();
    const placed = await placeOrder({ variantId, user, body: { coupon_code: code, ...(credit ? { apply_store_credit_ghs: credit } : {}) } });
    await hoursAgo(placed.order.id, 3);
    assert.equal((await runExpiry()).body.expired, 1);
    return { ...placed, user, variantId, code };
  }

  test('is kept when the stock is still there: the order takes its stock, credit and coupon again', async () => {
    const { order, reference, user, variantId, code } = await expiredOrder({ credit: 50 });
    assert.deepEqual([await stockOf(variantId), await creditOf(user.id), await usedCount(code)], [5, 50, 0]);

    await paidOnPaystack(reference, order.id, order.total);
    const row = await orderRow(order.id);
    assert.deepEqual([row.payment_status, row.status], ['paid', 'processing']);
    assert.deepEqual([await stockOf(variantId), await creditOf(user.id), await usedCount(code)], [3, 0, 1]);
    assert.equal(paystack.refunds.length, 0);
  });

  test('is refunded in full when the stock has gone, and nothing is taken', async () => {
    const { order, reference, variantId } = await expiredOrder();
    await db.query('UPDATE product_variants SET stock = 1 WHERE id = $1', [variantId]); // sold to someone else

    await paidOnPaystack(reference, order.id, order.total);
    assert.deepEqual(paystack.refunds, [{ transaction: reference, amount: Math.round(money(order.total) * 100) }]);
    const row = await orderRow(order.id);
    assert.deepEqual([row.payment_status, row.status], ['refunded', 'cancelled']);
    assert.equal(await stockOf(variantId), 1);
  });

  test('is refunded when the store credit it used has been spent since', async () => {
    const { order, reference, user, variantId } = await expiredOrder({ credit: 50 });
    await db.query('UPDATE users SET store_credit_ghs = 0 WHERE id = $1', [user.id]);

    await paidOnPaystack(reference, order.id, order.total);
    assert.equal(paystack.refunds.length, 1);
    assert.equal(await stockOf(variantId), 5, 'stock is not taken again');
  });

  test('arriving twice (webhook and return from Paystack) refunds once', async () => {
    const { order, reference, variantId } = await expiredOrder();
    await db.query('UPDATE product_variants SET stock = 0 WHERE id = $1', [variantId]);
    const charge = { reference, status: 'success', currency: 'GHS', amount: Math.round(money(order.total) * 100), metadata: { order_id: order.id } };
    paystack.tx.set(reference, charge);
    const raw = JSON.stringify({ event: 'charge.success', data: charge });

    await Promise.all([
      fetch(`${base}/api/webhooks/paystack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-paystack-signature': crypto.createHmac('sha512', SECRET).update(raw).digest('hex') },
        body: raw,
      }),
      fetch(`${base}/api/checkout/verify/${encodeURIComponent(reference)}`),
    ]);
    assert.equal(paystack.refunds.length, 1);
  });

  test("is refunded, not reinstated, when an admin cancelled the order, even with stock", async () => {
    const variantId = await product({ stock: 5 });
    const { order, reference } = await placeOrder({ variantId });
    const cancel = await fetch(`${base}/api/admin/orders/${order.id}/status`, {
      method: 'PUT', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    assert.equal(cancel.status, 200);

    await paidOnPaystack(reference, order.id, order.total);
    assert.equal(paystack.refunds.length, 1);
    assert.equal((await orderRow(order.id)).status, 'cancelled');
    assert.equal(await stockOf(variantId), 5);
  });
});

// ── The cron endpoints ───────────────────────────────────────────────
describe('the scheduled-job endpoints', { skip }, () => {
  test('refuse a missing or wrong secret, and refuse everything when no secret is set', async () => {
    assert.equal((await runExpiry(null)).status, 401);
    assert.equal((await runExpiry('Bearer not-it')).status, 401);
    delete process.env.CRON_SECRET;
    try {
      assert.equal((await runExpiry()).status, 503);
    } finally {
      process.env.CRON_SECRET = CRON;
    }
  });

  test('abandoned-cart emails and points expiry keep their on/off switches', async () => {
    for (const job of ['abandoned-cart', 'loyalty-expire']) {
      const res = await fetch(`${base}/api/cron/${job}`, { method: 'POST', headers: { authorization: `Bearer ${CRON}` } });
      assert.equal(res.status, 200);
      assert.match(JSON.stringify(await res.json()), /skipped/, job);
    }
  });
});
