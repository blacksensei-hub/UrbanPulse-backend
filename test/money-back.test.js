// test/money-back.test.js
//
// Money going back to customers, through the real routes and a real
// (throwaway) database: refunding a return, manual refunds, refunding a whole
// order, cancelling an unpaid order, first-order coupons, store credit
// adjustments and referral rewards. Paystack is replaced by a stand-in that
// keeps track of what was charged and refunded per transaction and, like
// Paystack, refuses to refund more than was charged; it answers after a short
// delay, as the network would, so two clicks overlap as they would live.

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createTestDatabase, dropTestDatabase, skipReason } from './support/testdb.js';

// false, not null: node:test treats `skip: null` as "skip".
const skip = skipReason() || false;
const DB_NAME = `urbanpulse_test_money_back_${process.pid}`;
const SECRET = 'sk_test_local_only';

// Set before the app loads: no .env file, no mail or SMS, a test key.
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: 'test/support/no-such.env',
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-only-jwt-secret',
  PAYSTACK_SECRET_KEY: SECRET,
  SMTP_HOST: '',
  SMS_API_KEY: '',
  SENTRY_DSN: '',
  FRONTEND_URL: 'http://localhost:5173',
});

// ── Paystack stand-in ────────────────────────────────────────────────
const paystack = { charged: new Map(), refunds: [] };
const refundedOn = (reference) =>
  paystack.refunds.filter((r) => r.transaction === reference).reduce((sum, r) => sum + r.amount, 0);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.paystack.co/transaction/initialize')) {
    const body = JSON.parse(options.body);
    return Response.json({
      status: true,
      data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, access_code: 'ac', reference: body.reference },
    });
  }
  if (u === 'https://api.paystack.co/refund') {
    const body = JSON.parse(options.body);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const charged = paystack.charged.get(body.transaction);
    if (charged == null) return Response.json({ status: false, message: 'Transaction not found' }, { status: 404 });
    // No amount means the whole transaction, as with Paystack.
    const amount = body.amount ?? charged;
    if (refundedOn(body.transaction) + amount > charged) {
      return Response.json({ status: false, message: 'Refund amount is more than the transaction amount' }, { status: 400 });
    }
    paystack.refunds.push({ transaction: body.transaction, amount });
    return Response.json({ status: true, data: { amount, status: 'pending' } });
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
  const orderRoutes = (await import('../src/routes/orders.js')).default;
  const checkoutRoutes = (await import('../src/routes/checkout.js')).default;
  const webhookRoutes = (await import('../src/routes/webhooks.js')).default;
  const adminRoutes = (await import('../src/routes/admin.js')).default;

  // Mounted as in server.js: the webhook gets the raw body it signs.
  const app = express();
  app.use(cookieParser());
  app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
  app.use(express.json());
  app.use('/api/orders', orderRoutes);
  app.use('/api/checkout', checkoutRoutes);
  app.use('/api/admin', adminRoutes);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const { rows: [admin] } = await db.query(
    "INSERT INTO users (email, name, role) VALUES ('money-admin@example.test', 'Money Admin', 'admin') RETURNING id, role",
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
  const { rows: [p] } = await db.query(
    'INSERT INTO products (slug, name, price) VALUES ($1, $2, $3) RETURNING id',
    [`money-item-${seq}`, `Money item ${seq}`, price],
  );
  const { rows: [v] } = await db.query(
    "INSERT INTO product_variants (product_id, size, color, stock) VALUES ($1, 'M', 'Black', $2) RETURNING id",
    [p.id, stock],
  );
  return v.id;
}

async function customer({ credit = 0, points = 0 } = {}) {
  seq += 1;
  const { rows: [u] } = await db.query(
    'INSERT INTO users (email, name, store_credit_ghs, loyalty_points) VALUES ($1, $2, $3, $4) RETURNING id, role, email',
    [`money${seq}@example.test`, `Customer ${seq}`, credit, points],
  );
  return { id: u.id, email: u.email, token: signAccess(u) };
}

async function coupon(fields) {
  seq += 1;
  const code = `MONEY${seq}`;
  const cols = { code, type: 'fixed', value: 20, ...fields };
  const keys = Object.keys(cols);
  await db.query(
    `INSERT INTO coupons (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(cols),
  );
  return code;
}

// Places an order from a fresh cart, as a signed-in customer or a guest.
async function placeOrder({ variantId, qty = 1, user, body = {} }) {
  seq += 1;
  const session = `money-session-${seq}-${process.pid}`;
  const { rows: [c] } = await db.query(
    'INSERT INTO carts (session_id, user_id) VALUES ($1, $2) RETURNING id',
    [user ? null : session, user?.id ?? null],
  );
  await db.query('INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, $3)', [c.id, variantId, qty]);
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${user.token}`;
  else headers['x-session-id'] = session;
  const res = await fetch(`${base}/api/orders`, {
    method: 'POST', headers,
    body: JSON.stringify({ shipping_address: address, email: user?.email ?? 'guest@example.test', ...body }),
  });
  return { status: res.status, body: await res.json(), headers };
}

// Places an order and pays for it in full through Paystack.
async function paidOrder(args) {
  const placed = await placeOrder(args);
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const start = await fetch(`${base}/api/checkout/session`, {
    method: 'POST', headers: placed.headers, body: JSON.stringify({ order_id: placed.body.id }),
  });
  const { reference } = await start.json();
  const pesewas = Math.round(money(placed.body.total) * 100);
  paystack.charged.set(reference, pesewas);
  const raw = JSON.stringify({
    event: 'charge.success',
    data: { reference, status: 'success', currency: 'GHS', amount: pesewas, metadata: { order_id: placed.body.id } },
  });
  const hook = await fetch(`${base}/api/webhooks/paystack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': crypto.createHmac('sha512', SECRET).update(raw).digest('hex') },
    body: raw,
  });
  assert.equal(hook.status, 200);
  const order = await orderRow(placed.body.id);
  assert.equal(order.payment_status, 'paid');
  return order;
}

async function admin(method, path, body) {
  const res = await fetch(`${base}/api/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A return the warehouse has received, ready to refund.
async function receivedReturn(order, { resolution = 'refund', qty = 1 } = {}) {
  const { rows: [item] } = await db.query(
    'SELECT id, variant_id FROM order_items WHERE order_id = $1 ORDER BY id LIMIT 1', [order.id],
  );
  seq += 1;
  const { rows: [r] } = await db.query(
    `INSERT INTO returns (order_id, user_id, rma_number, status, resolution, reason_code)
     VALUES ($1, $2, $3, 'received', $4, 'damaged') RETURNING id`,
    [order.id, order.user_id, `RMA-MONEY-${seq}`, resolution],
  );
  await db.query(
    'INSERT INTO return_items (return_id, order_item_id, quantity, variant_id) VALUES ($1, $2, $3, $4)',
    [r.id, item.id, qty, item.variant_id],
  );
  return r.id;
}

const orderRow = async (id) => (await db.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
const stockOf = async (variantId) => (await db.query('SELECT stock FROM product_variants WHERE id = $1', [variantId])).rows[0].stock;
const creditOf = async (userId) => money((await db.query('SELECT store_credit_ghs FROM users WHERE id = $1', [userId])).rows[0].store_credit_ghs);
const usedCount = async (code) => (await db.query('SELECT used_count FROM coupons WHERE code = $1', [code])).rows[0].used_count;
const pointsOf = async (userId) => (await db.query('SELECT loyalty_points FROM users WHERE id = $1', [userId])).rows[0].loyalty_points;
const returnedPoints = async (userId) => (await db.query(
  `SELECT delta, expires_at > NOW() + interval '300 days' AS fresh FROM loyalty_ledger WHERE user_id = $1 AND reason = 'points_returned' ORDER BY id`,
  [userId],
)).rows;
const statuses = (results) => results.map((r) => r.status).sort();

beforeEach(async () => {
  if (skip) return;
  paystack.charged.clear();
  paystack.refunds.length = 0;
  await db.query('DELETE FROM site_settings');
  for (const [key, value] of Object.entries({ tax_rate_percent: 12.5, shipping_standard_ghs: 30, free_shipping_threshold_ghs: 1000 })) {
    await db.query('INSERT INTO site_settings (key, value) VALUES ($1, $2::jsonb)', [key, JSON.stringify(value)]);
  }
  invalidateSettings();
});

// Two units at GH₵200, delivery GH₵30, tax 12.5%: GH₵480.

// ── Refunding a return ───────────────────────────────────────────────
describe('refunding a return', { skip }, () => {
  test('a card refund goes back through Paystack for that amount, and restocks when asked', async () => {
    const user = await customer();
    const variantId = await product({ stock: 5 });
    const order = await paidOrder({ variantId, qty: 2, user });
    const returnId = await receivedReturn(order);

    const res = await admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 200, restock: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'refunded');
    assert.deepEqual(paystack.refunds, [{ transaction: order.paystack_reference, amount: 20000 }]);
    assert.equal(await stockOf(variantId), 4);
  });

  test('a store-credit return adds to the balance and the ledger, and nothing goes through Paystack', async () => {
    const user = await customer();
    const order = await paidOrder({ variantId: await product(), qty: 2, user });
    const returnId = await receivedReturn(order, { resolution: 'store_credit' });

    assert.equal((await admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 150 })).status, 200);
    assert.equal(await creditOf(user.id), 150);
    const { rows } = await db.query('SELECT amount_ghs, reason FROM store_credit_ledger WHERE user_id = $1', [user.id]);
    assert.deepEqual(rows.map((r) => [money(r.amount_ghs), r.reason]), [[150, 'refund']]);
    assert.equal(paystack.refunds.length, 0);
  });

  test('only a received return can be refunded', async () => {
    const user = await customer();
    const order = await paidOrder({ variantId: await product(), qty: 2, user });
    const returnId = await receivedReturn(order);
    for (const status of ['requested', 'approved', 'rejected']) {
      await db.query('UPDATE returns SET status = $1 WHERE id = $2', [status, returnId]);
      assert.equal((await admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 100 })).status, 400, status);
    }
    assert.equal(paystack.refunds.length, 0);
  });

  test('two clicks at once refund once', async () => {
    const user = await customer();
    const variantId = await product({ stock: 5 });
    const order = await paidOrder({ variantId, qty: 2, user });
    const returnId = await receivedReturn(order);

    const results = await Promise.all([
      admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 200, restock: true }),
      admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 200, restock: true }),
    ]);
    assert.deepEqual(statuses(results), [200, 400]);
    assert.equal(paystack.refunds.length, 1, 'refunded once through Paystack');
    assert.equal(await stockOf(variantId), 4, 'restocked once');
  });

  test('refunds of every kind together never come to more than was paid', async () => {
    const user = await customer();
    const order = await paidOrder({ variantId: await product(), qty: 2, user });
    assert.equal(money(order.total), 480);

    const manual = await admin('POST', `/orders/${order.id}/manual-refund`, { amount_ghs: 300, method: 'paystack', reason: 'Late delivery' });
    assert.equal(manual.status, 200);
    const returnId = await receivedReturn(order);
    const tooMuch = await admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 200 });
    assert.equal(tooMuch.status, 400);
    assert.match(JSON.stringify(tooMuch.body), /180\.00/);
    assert.equal((await admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 180 })).status, 200);
    assert.equal(refundedOn(order.paystack_reference), 48000);
  });
});

// ── Manual refunds ───────────────────────────────────────────────────
describe('manual refunds', { skip }, () => {
  test('go to store credit or back through Paystack, and stop at what was paid', async () => {
    const user = await customer();
    const order = await paidOrder({ variantId: await product(), qty: 2, user });

    assert.equal((await admin('POST', `/orders/${order.id}/manual-refund`, { amount_ghs: 100, method: 'store_credit', reason: 'Goodwill' })).status, 200);
    assert.equal(await creditOf(user.id), 100);
    assert.equal((await admin('POST', `/orders/${order.id}/manual-refund`, { amount_ghs: 400, method: 'paystack', reason: 'Too much' })).status, 400);
    assert.equal((await admin('POST', `/orders/${order.id}/manual-refund`, { amount_ghs: 380, method: 'paystack', reason: 'The rest' })).status, 200);
    assert.deepEqual(paystack.refunds, [{ transaction: order.paystack_reference, amount: 38000 }]);
  });

  test('a manual refund counts what returns already gave back', async () => {
    const user = await customer();
    const order = await paidOrder({ variantId: await product(), qty: 2, user });
    const returnId = await receivedReturn(order, { resolution: 'store_credit' });
    assert.equal((await admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 300 })).status, 200);

    assert.equal((await admin('POST', `/orders/${order.id}/manual-refund`, { amount_ghs: 200, method: 'store_credit', reason: 'More' })).status, 400);
    assert.equal(await creditOf(user.id), 300);
  });

  test('two clicks at once never refund more than was paid', async () => {
    const user = await customer();
    const order = await paidOrder({ variantId: await product(), qty: 2, user });
    const results = await Promise.all([
      admin('POST', `/orders/${order.id}/manual-refund`, { amount_ghs: 300, method: 'store_credit', reason: 'Twice' }),
      admin('POST', `/orders/${order.id}/manual-refund`, { amount_ghs: 300, method: 'store_credit', reason: 'Twice' }),
    ]);
    assert.deepEqual(statuses(results), [200, 400]);
    assert.equal(await creditOf(user.id), 300);
  });
});

// ── Refunding a whole order ──────────────────────────────────────────
describe('refunding a whole order', { skip }, () => {
  test('gives back the total through Paystack, the store credit spent and the stock', async () => {
    const user = await customer({ credit: 100 });
    const variantId = await product({ stock: 5 });
    const order = await paidOrder({ variantId, qty: 2, user, body: { apply_store_credit_ghs: 100 } });
    assert.equal(money(order.total), 380);
    assert.equal(await stockOf(variantId), 3);

    const res = await admin('POST', `/orders/${order.id}/refund`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(refundedOn(order.paystack_reference), 38000);
    assert.equal(await creditOf(user.id), 100);
    assert.equal(await stockOf(variantId), 5);
    assert.equal((await orderRow(order.id)).payment_status, 'refunded');
  });

  test('after a return was refunded, only the rest goes back and returned items are not restocked twice', async () => {
    const user = await customer();
    const variantId = await product({ stock: 5 });
    const order = await paidOrder({ variantId, qty: 2, user });
    const returnId = await receivedReturn(order);
    assert.equal((await admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 200, restock: true })).status, 200);
    assert.equal(await stockOf(variantId), 4);

    const res = await admin('POST', `/orders/${order.id}/refund`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(refundedOn(order.paystack_reference), 48000, 'GH₵200 then the remaining GH₵280');
    assert.equal(await stockOf(variantId), 5, 'the returned unit is not put back a second time');
  });

  test('when Paystack refuses, nothing is recorded and the refund can be tried again', async () => {
    const user = await customer();
    const variantId = await product({ stock: 5 });
    const order = await paidOrder({ variantId, qty: 2, user });
    const returnId = await receivedReturn(order);
    const charged = paystack.charged.get(order.paystack_reference);
    paystack.charged.delete(order.paystack_reference); // Paystack: "Transaction not found"

    assert.equal((await admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 200, restock: true })).status, 500);
    assert.equal((await admin('POST', `/orders/${order.id}/manual-refund`, { amount_ghs: 50, method: 'paystack', reason: 'Try' })).status, 500);
    assert.equal((await admin('POST', `/orders/${order.id}/refund`)).status, 500);
    const { rows: [ret] } = await db.query('SELECT status, refund_amount_ghs FROM returns WHERE id = $1', [returnId]);
    assert.deepEqual([ret.status, ret.refund_amount_ghs], ['received', null]);
    const after = await orderRow(order.id);
    assert.deepEqual([after.payment_status, after.status], ['paid', 'processing']);
    const { rows: edits } = await db.query("SELECT 1 FROM order_edits WHERE order_id = $1 AND field IN ('refund', 'manual_refund')", [order.id]);
    assert.equal(edits.length, 0);
    assert.equal(await stockOf(variantId), 3);

    paystack.charged.set(order.paystack_reference, charged);
    assert.equal((await admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 200, restock: true })).status, 200);
    assert.equal((await admin('POST', `/orders/${order.id}/refund`)).status, 200);
    assert.equal(refundedOn(order.paystack_reference), 48000);
  });

  test('an unpaid order, or one already refunded, is refused', async () => {
    const unpaid = await placeOrder({ variantId: await product() });
    assert.equal((await admin('POST', `/orders/${unpaid.body.id}/refund`)).status, 400);

    const order = await paidOrder({ variantId: await product(), qty: 2, user: await customer() });
    assert.equal((await admin('POST', `/orders/${order.id}/refund`)).status, 200);
    assert.equal((await admin('POST', `/orders/${order.id}/refund`)).status, 400);
    assert.equal(paystack.refunds.length, 1);
  });
});

// ── Cancelling an unpaid order ───────────────────────────────────────
describe('cancelling an unpaid order', { skip }, () => {
  test('cash on delivery gives back the stock, the store credit and the coupon use', async () => {
    const user = await customer({ credit: 50 });
    const variantId = await product({ stock: 5 });
    const code = await coupon({ usage_limit: 10 });
    const placed = await placeOrder({ variantId, qty: 2, user, body: { payment_method: 'cod', coupon_code: code, apply_store_credit_ghs: 50 } });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.deepEqual([await stockOf(variantId), await creditOf(user.id), await usedCount(code)], [3, 0, 1]);

    assert.equal((await admin('POST', `/orders/${placed.body.id}/cancel-cod`)).status, 200);
    assert.deepEqual([await stockOf(variantId), await creditOf(user.id), await usedCount(code)], [5, 50, 0]);
  });

  test('a Paystack order never paid, cancelled from the order page, gives everything back too', async () => {
    const user = await customer({ credit: 50 });
    const variantId = await product({ stock: 5 });
    const code = await coupon({ usage_limit: 10 });
    const placed = await placeOrder({ variantId, qty: 2, user, body: { coupon_code: code, apply_store_credit_ghs: 50 } });
    assert.equal(placed.status, 201);

    assert.equal((await admin('PUT', `/orders/${placed.body.id}/status`, { status: 'cancelled' })).status, 200);
    assert.deepEqual([await stockOf(variantId), await creditOf(user.id), await usedCount(code)], [5, 50, 0]);
  });

  test('cancelling twice at once gives back once', async () => {
    const user = await customer({ credit: 50 });
    const variantId = await product({ stock: 5 });
    const placed = await placeOrder({ variantId, qty: 2, user, body: { payment_method: 'cod', apply_store_credit_ghs: 50 } });

    await Promise.all([
      admin('POST', `/orders/${placed.body.id}/cancel-cod`),
      admin('POST', `/orders/${placed.body.id}/cancel-cod`),
    ]);
    assert.equal(await stockOf(variantId), 5);
    assert.equal(await creditOf(user.id), 50);
  });

  test("a cancelled order can't be reopened, since what it held went back", async () => {
    const variantId = await product({ stock: 5 });
    const placed = await placeOrder({ variantId, qty: 2, user: await customer() });
    assert.equal((await admin('PUT', `/orders/${placed.body.id}/status`, { status: 'cancelled' })).status, 200);
    assert.equal((await admin('PUT', `/orders/${placed.body.id}/status`, { status: 'processing' })).status, 400);
    assert.equal(await stockOf(variantId), 5);
  });

  test('a paid order cannot be cancelled', async () => {
    const variantId = await product({ stock: 5 });
    const order = await paidOrder({ variantId, qty: 2, user: await customer() });
    assert.equal((await admin('PUT', `/orders/${order.id}/status`, { status: 'cancelled' })).status, 400);
    assert.equal(await stockOf(variantId), 3);
  });
});

// ── Loyalty points spent on an order ─────────────────────────────────
describe('loyalty points spent on an order', { skip }, () => {
  test('come back when an unpaid order is cancelled, as a fresh batch that expires later', async () => {
    const user = await customer({ points: 300 });
    const placed = await placeOrder({ variantId: await product(), qty: 2, user, body: { payment_method: 'cod', apply_loyalty_points: 200 } });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.equal(await pointsOf(user.id), 100);

    assert.equal((await admin('POST', `/orders/${placed.body.id}/cancel-cod`)).status, 200);
    assert.equal(await pointsOf(user.id), 300);
    assert.deepEqual(await returnedPoints(user.id), [{ delta: 200, fresh: true }]);
  });

  test('come back on a full refund, but not on a partial one', async () => {
    const user = await customer({ points: 300 });
    const order = await paidOrder({ variantId: await product(), qty: 2, user, body: { apply_loyalty_points: 200 } });

    const returnId = await receivedReturn(order);
    assert.equal((await admin('POST', `/returns/${returnId}/refund`, { refund_amount_ghs: 100 })).status, 200);
    assert.deepEqual(await returnedPoints(user.id), [], 'a partial refund returns no points');

    const before = await pointsOf(user.id);
    assert.equal((await admin('POST', `/orders/${order.id}/refund`)).status, 200);
    assert.deepEqual(await returnedPoints(user.id), [{ delta: 200, fresh: true }]);
    assert.equal(await pointsOf(user.id), before + 200);
  });
});

// ── First-order coupons ──────────────────────────────────────────────
describe('first-order coupons', { skip }, () => {
  test('a guest can use one once, not again under the same email', async () => {
    const code = await coupon({ first_order_only: true });
    const first = await paidOrder({ variantId: await product(), body: { email: 'kojo@example.test', coupon_code: code } });
    assert.ok(first.id);
    const again = await placeOrder({ variantId: await product(), body: { email: 'Kojo@Example.test', coupon_code: code } });
    assert.equal(again.status, 400);
    assert.match(JSON.stringify(again.body), /first orders only/);
  });

  test("an order abandoned before paying doesn't use up a customer's first order", async () => {
    const user = await customer();
    const code = await coupon({ first_order_only: true });
    const abandoned = await placeOrder({ variantId: await product(), user });
    assert.equal(abandoned.status, 201);
    const res = await placeOrder({ variantId: await product(), user, body: { coupon_code: code } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test('a customer with a paid order is refused', async () => {
    const user = await customer();
    const code = await coupon({ first_order_only: true });
    await paidOrder({ variantId: await product(), user });
    assert.equal((await placeOrder({ variantId: await product(), user, body: { coupon_code: code } })).status, 400);
  });
});

// ── Store credit and referral rewards ────────────────────────────────
describe('store credit and referral rewards', { skip }, () => {
  test('an admin adjustment never takes a balance below zero', async () => {
    const user = await customer({ credit: 30 });
    const res = await admin('POST', `/customers/${user.id}/adjust-credit`, { amount_ghs: -50, reason: 'Correction' });
    assert.equal(res.status, 200);
    assert.deepEqual([money(res.body.balance), money(res.body.delta)], [0, -30]);
    assert.equal(await creditOf(user.id), 0);
  });

  test("a referred customer's first paid order rewards both people once", async () => {
    const referrer = await customer();
    const referred = await customer();
    await db.query(
      "INSERT INTO referrals (referrer_user_id, referred_user_id, referred_email, status) VALUES ($1, $2, $3, 'pending')",
      [referrer.id, referred.id, referred.email],
    );
    await paidOrder({ variantId: await product(), user: referred });
    assert.deepEqual([await creditOf(referrer.id), await creditOf(referred.id)], [50, 50]);
    await paidOrder({ variantId: await product(), user: referred });
    assert.deepEqual([await creditOf(referrer.id), await creditOf(referred.id)], [50, 50]);
  });
});
