// test/checkout.test.js
//
// The money path, through the real routes and a real (throwaway) database:
// order totals, coupons, store credit, stock, starting a Paystack payment,
// and the webhook that marks an order paid. Paystack is replaced by a
// stand-in that records what it was sent; email and SMS are off; any other
// outside connection fails the test.

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createTestDatabase, dropTestDatabase, skipReason } from './support/testdb.js';

// false, not null: node:test treats `skip: null` as "skip".
const skip = skipReason() || false;
const DB_NAME = `urbanpulse_test_checkout_${process.pid}`;
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
const paystack = { initialized: [], transactions: new Map() };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.paystack.co/transaction/initialize')) {
    const body = JSON.parse(options.body);
    paystack.initialized.push(body);
    return Response.json({
      status: true,
      data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, access_code: 'ac', reference: body.reference },
    });
  }
  if (u.startsWith('https://api.paystack.co/transaction/verify/')) {
    const data = paystack.transactions.get(decodeURIComponent(u.split('/').pop()));
    return data
      ? Response.json({ status: true, data })
      : Response.json({ status: false, message: 'Transaction not found' }, { status: 404 });
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

  // Mounted as in server.js: the webhook gets the raw body it signs.
  const app = express();
  app.use(cookieParser());
  app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
  app.use(express.json());
  app.use('/api/orders', orderRoutes);
  app.use('/api/checkout', checkoutRoutes);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (skip) return;
  server?.close();
  await db?.end();
  await dropTestDatabase(DB_NAME);
});

// ── Fixtures ─────────────────────────────────────────────────────────
let seq = 0;
const session = () => `test-session-${++seq}-${process.pid}`;

async function product({ price = 200, stock = 5 } = {}) {
  seq += 1;
  const { rows: [p] } = await db.query(
    'INSERT INTO products (slug, name, price) VALUES ($1, $2, $3) RETURNING id',
    [`test-item-${seq}`, `Test item ${seq}`, price],
  );
  const { rows: [v] } = await db.query(
    "INSERT INTO product_variants (product_id, size, color, stock) VALUES ($1, 'M', 'Black', $2) RETURNING id",
    [p.id, stock],
  );
  return { productId: p.id, variantId: v.id };
}

async function cart(owner, lines) {
  const { rows: [c] } = await db.query(
    'INSERT INTO carts (session_id, user_id) VALUES ($1, $2) RETURNING id',
    [owner.session ?? null, owner.userId ?? null],
  );
  for (const line of lines) {
    await db.query('INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, $3)',
      [c.id, line.variantId, line.qty ?? 1]);
  }
  return c.id;
}

async function settings(values) {
  await db.query('DELETE FROM site_settings');
  for (const [key, value] of Object.entries(values)) {
    await db.query('INSERT INTO site_settings (key, value) VALUES ($1, $2::jsonb)', [key, JSON.stringify(value)]);
  }
  invalidateSettings();
}

async function customer({ credit = 0 } = {}) {
  seq += 1;
  const { rows: [u] } = await db.query(
    'INSERT INTO users (email, name, store_credit_ghs) VALUES ($1, $2, $3) RETURNING id, role',
    [`customer${seq}@example.test`, `Customer ${seq}`, credit],
  );
  return { id: u.id, token: signAccess(u) };
}

const address = { name: 'Ama Mensah', line1: '12 Oxford St', city: 'Accra', state: 'Greater Accra', phone: '0244000000' };

async function placeOrder({ lines, user, body = {} }) {
  const owner = user ? { userId: user.id } : { session: session() };
  await cart(owner, lines);
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${user.token}`;
  else headers['x-session-id'] = owner.session;
  const res = await fetch(`${base}/api/orders`, {
    method: 'POST', headers,
    body: JSON.stringify({ shipping_address: address, email: 'buyer@example.test', ...body }),
  });
  return { status: res.status, body: await res.json(), owner };
}

const orderRow = async (id) => (await db.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
const stockOf = async (variantId) => (await db.query('SELECT stock FROM product_variants WHERE id = $1', [variantId])).rows[0].stock;
const money = (v) => Number(v);

async function startPayment(orderId, headers = {}) {
  const res = await fetch(`${base}/api/checkout/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ order_id: orderId }),
  });
  return { status: res.status, body: await res.json() };
}

function chargeSuccess({ reference, amountGhs, orderId }) {
  return {
    event: 'charge.success',
    data: {
      reference, status: 'success', currency: 'GHS',
      amount: Math.round(amountGhs * 100),
      metadata: { order_id: orderId },
    },
  };
}

async function webhook(event, signature) {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/webhooks/paystack`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-paystack-signature': signature ?? crypto.createHmac('sha512', SECRET).update(raw).digest('hex'),
    },
    body: raw,
  });
  return res.status;
}

async function orderAwaitingPayment() {
  const { variantId } = await product({ price: 200 });
  const { body: order } = await placeOrder({ lines: [{ variantId }] });
  const { body: session } = await startPayment(order.id);
  return { order: await orderRow(order.id), reference: session.reference };
}

beforeEach(async () => {
  if (skip) return;
  paystack.initialized.length = 0;
  paystack.transactions.clear();
  await settings({ tax_rate_percent: 12.5, shipping_standard_ghs: 30, shipping_express_ghs: 80, free_shipping_threshold_ghs: 1000 });
});

// ── Totals ───────────────────────────────────────────────────────────
describe('order totals', { skip }, () => {
  test('subtotal, standard delivery and tax add up to the total', async () => {
    const { variantId } = await product({ price: 200 });
    const { status, body } = await placeOrder({ lines: [{ variantId, qty: 2 }] });
    assert.equal(status, 201);
    assert.equal(money(body.subtotal), 400);
    assert.equal(money(body.shipping_cost), 30);
    assert.equal(money(body.tax), 50);
    assert.equal(money(body.total), 480);
  });

  test('standard delivery is free at the threshold, express never is', async () => {
    await settings({ tax_rate_percent: 0, shipping_standard_ghs: 30, shipping_express_ghs: 80, free_shipping_threshold_ghs: 400 });
    const { variantId } = await product({ price: 400 });
    const standard = await placeOrder({ lines: [{ variantId }] });
    assert.equal(money(standard.body.shipping_cost), 0);
    const express = await placeOrder({ lines: [{ variantId }], body: { shipping_method: 'express' } });
    assert.equal(money(express.body.shipping_cost), 80);
    assert.equal(money(express.body.total), 480);
  });

  test("with region pricing on, the region's own rate is charged", async () => {
    await settings({
      tax_rate_percent: 0, shipping_standard_ghs: 30, free_shipping_threshold_ghs: 1000,
      delivery_regions_enabled: true,
      delivery_regions: { 'Upper West': { standard: 65, express: 120 } },
    });
    const { variantId } = await product({ price: 100 });
    const { body } = await placeOrder({ lines: [{ variantId }], body: { shipping_address: { ...address, state: 'Upper West' } } });
    assert.equal(money(body.shipping_cost), 65);
  });

  test('a bundle saving comes off the total and is recorded on the order', async () => {
    const jersey = await product({ price: 150 });
    const jeans = await product({ price: 250 });
    await settings({
      tax_rate_percent: 0, shipping_standard_ghs: 30, free_shipping_threshold_ghs: 1000,
      bundles: [{ id: 'kit', name: 'Kit', product_ids: [jersey.productId, jeans.productId], price_ghs: 350, active: true }],
    });
    const { body } = await placeOrder({ lines: [{ variantId: jersey.variantId }, { variantId: jeans.variantId }] });
    assert.equal(money(body.bundle_discount_ghs), 50);
    assert.equal(money(body.total), 400 + 30 - 50);
  });
});

// ── Coupons ──────────────────────────────────────────────────────────
describe('coupons', { skip }, () => {
  async function coupon(fields) {
    seq += 1;
    const code = `TEST${seq}`;
    const cols = { code, type: 'percentage', value: 10, ...fields };
    const keys = Object.keys(cols);
    await db.query(
      `INSERT INTO coupons (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(cols),
    );
    return code;
  }

  test('a percentage coupon comes off the subtotal and is counted as used', async () => {
    const code = await coupon({ type: 'percentage', value: 10 });
    const { variantId } = await product({ price: 200 });
    const { status, body } = await placeOrder({ lines: [{ variantId }], body: { coupon_code: code } });
    assert.equal(status, 201);
    assert.equal(money(body.total), 200 + 30 + 25 - 20);
    const { rows } = await db.query('SELECT used_count FROM coupons WHERE code = $1', [code]);
    assert.equal(rows[0].used_count, 1);
  });

  test('a fixed coupon never takes more than the subtotal', async () => {
    const code = await coupon({ type: 'fixed', value: 500 });
    const { variantId } = await product({ price: 200 });
    const { body } = await placeOrder({ lines: [{ variantId }], body: { coupon_code: code } });
    assert.equal(money(body.total), 30 + 25);
  });

  test('a free-delivery coupon takes the delivery off', async () => {
    const code = await coupon({ type: 'free_shipping', value: 0 });
    const { variantId } = await product({ price: 200 });
    const { body } = await placeOrder({ lines: [{ variantId }], body: { coupon_code: code } });
    assert.equal(money(body.total), 200 + 25);
  });

  test('expired, inactive, used-up and under-minimum coupons are refused, and nothing is ordered', async () => {
    const cases = {
      expired: { valid_until: new Date(Date.now() - 86_400_000) },
      inactive: { is_active: false },
      'used up': { usage_limit: 1, used_count: 1 },
      'under the minimum': { min_order_amount: 500 },
    };
    for (const [label, fields] of Object.entries(cases)) {
      const code = await coupon(fields);
      const { variantId } = await product({ price: 200, stock: 3 });
      const { status } = await placeOrder({ lines: [{ variantId }], body: { coupon_code: code } });
      assert.equal(status, 400, label);
      assert.equal(await stockOf(variantId), 3, `${label}: stock untouched`);
    }
  });

  test('two orders racing for the last use of a coupon: only one gets it', async () => {
    const code = await coupon({ type: 'fixed', value: 20, usage_limit: 1 });
    const a = await product({ price: 200 });
    const b = await product({ price: 200 });
    const results = await Promise.all([
      placeOrder({ lines: [{ variantId: a.variantId }], body: { coupon_code: code } }),
      placeOrder({ lines: [{ variantId: b.variantId }], body: { coupon_code: code } }),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 400]);
    const { rows } = await db.query('SELECT used_count FROM coupons WHERE code = $1', [code]);
    assert.equal(rows[0].used_count, 1);
  });
});

// ── Store credit ─────────────────────────────────────────────────────
describe('store credit', { skip }, () => {
  test('is capped at the balance, deducted, and written to the ledger', async () => {
    const user = await customer({ credit: 40 });
    const { variantId } = await product({ price: 200 });
    const { body } = await placeOrder({ lines: [{ variantId }], user, body: { apply_store_credit_ghs: 100 } });
    assert.equal(money(body.total), 255 - 40);
    const { rows: [u] } = await db.query('SELECT store_credit_ghs FROM users WHERE id = $1', [user.id]);
    assert.equal(money(u.store_credit_ghs), 0);
    const { rows: [l] } = await db.query('SELECT amount_ghs, reason FROM store_credit_ledger WHERE user_id = $1', [user.id]);
    assert.equal(money(l.amount_ghs), -40);
    assert.equal(l.reason, 'spent_on_order');
  });

  test('never takes the total below zero', async () => {
    const user = await customer({ credit: 1000 });
    const { variantId } = await product({ price: 200 });
    const { body } = await placeOrder({ lines: [{ variantId }], user, body: { apply_store_credit_ghs: 1000 } });
    assert.equal(money(body.total), 0);
    const { rows: [u] } = await db.query('SELECT store_credit_ghs FROM users WHERE id = $1', [user.id]);
    assert.equal(money(u.store_credit_ghs), 1000 - 255);
  });

  test("a guest can't spend store credit", async () => {
    const { variantId } = await product({ price: 200 });
    const { body } = await placeOrder({ lines: [{ variantId }], body: { apply_store_credit_ghs: 100 } });
    assert.equal(money(body.total), 255);
  });
});

// ── Stock ────────────────────────────────────────────────────────────
describe('stock', { skip }, () => {
  test('an order takes its units out of stock', async () => {
    const { variantId } = await product({ stock: 5 });
    const { status } = await placeOrder({ lines: [{ variantId, qty: 2 }] });
    assert.equal(status, 201);
    assert.equal(await stockOf(variantId), 3);
  });

  test('more than is left is refused, and no order is created', async () => {
    const { variantId } = await product({ stock: 1 });
    const before = (await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
    const { status, body } = await placeOrder({ lines: [{ variantId, qty: 2 }] });
    assert.equal(status, 400);
    assert.match(body.error, /Out of stock/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, before);
    assert.equal(await stockOf(variantId), 1);
  });

  test('with cash on delivery turned off, a COD order is refused and nothing is taken', async () => {
    await settings({ tax_rate_percent: 12.5, shipping_standard_ghs: 30, shipping_express_ghs: 80, free_shipping_threshold_ghs: 1000, feature_cod: false });
    const { variantId } = await product({ stock: 2 });
    const { status, body } = await placeOrder({ lines: [{ variantId }], body: { payment_method: 'cod' } });
    assert.equal(status, 503);
    assert.match(body.error, /disabled/);
    assert.equal(await stockOf(variantId), 2);
  });

  test('two customers buying the last one at once: one gets it, stock never goes below zero', async () => {
    const { variantId } = await product({ stock: 1 });
    const results = await Promise.all([
      placeOrder({ lines: [{ variantId }] }),
      placeOrder({ lines: [{ variantId }] }),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 400]);
    assert.equal(await stockOf(variantId), 0);
  });
});

// ── Starting a payment ───────────────────────────────────────────────
describe('starting a Paystack payment', { skip }, () => {
  test('charges the order total in pesewas, under the order number, and empties the cart', async () => {
    const { variantId } = await product({ price: 200 });
    const { body: order, owner } = await placeOrder({ lines: [{ variantId }] });
    const { status, body } = await startPayment(order.id, { 'x-session-id': owner.session });
    assert.equal(status, 200);
    assert.equal(paystack.initialized[0].amount, 25500);
    assert.equal(paystack.initialized[0].currency, 'GHS');
    assert.equal(body.reference, order.order_number);
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.session_id = $1', [owner.session]);
    assert.equal(rows[0].n, 0);
  });

  test('a paid order cannot start another payment', async () => {
    const { order, reference } = await orderAwaitingPayment();
    await webhook(chargeSuccess({ reference, amountGhs: money(order.total), orderId: order.id }));
    const { status } = await startPayment(order.id);
    assert.equal(status, 400);
  });

  test("a signed-in customer's order can't be started by someone else", async () => {
    const owner = await customer();
    const stranger = await customer();
    const { variantId } = await product({ price: 200 });
    const { body: order } = await placeOrder({ lines: [{ variantId }], user: owner });
    const { status } = await startPayment(order.id, { authorization: `Bearer ${stranger.token}` });
    assert.equal(status, 404);
    assert.equal(paystack.initialized.length, 0);
  });
});

// ── The webhook ──────────────────────────────────────────────────────
describe('the Paystack webhook', { skip }, () => {
  test('a forged or unsigned message is refused and changes nothing', async () => {
    const { order, reference } = await orderAwaitingPayment();
    const event = chargeSuccess({ reference, amountGhs: money(order.total), orderId: order.id });
    assert.equal(await webhook(event, 'f'.repeat(128)), 401);
    assert.equal(await webhook(event, ''), 401);
    assert.equal((await orderRow(order.id)).payment_status, order.payment_status);
  });

  test('a signed charge.success marks the order paid and processing', async () => {
    const { order, reference } = await orderAwaitingPayment();
    assert.equal(await webhook(chargeSuccess({ reference, amountGhs: money(order.total), orderId: order.id })), 200);
    const paid = await orderRow(order.id);
    assert.equal(paid.payment_status, 'paid');
    assert.equal(paid.status, 'processing');
    const { rows } = await db.query('SELECT status FROM order_status_history WHERE order_id = $1 ORDER BY id', [order.id]);
    assert.deepEqual(rows.map(r => r.status), ['paid', 'processing']);
  });

  test('the same message sent twice is only applied once', async () => {
    const { order, reference } = await orderAwaitingPayment();
    const event = chargeSuccess({ reference, amountGhs: money(order.total), orderId: order.id });
    await webhook(event);
    await webhook(event);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM order_status_history WHERE order_id = $1', [order.id]);
    assert.equal(rows[0].n, 2);
  });

  test('other events change nothing', async () => {
    const { order, reference } = await orderAwaitingPayment();
    await webhook({ ...chargeSuccess({ reference, amountGhs: money(order.total), orderId: order.id }), event: 'charge.failed' });
    assert.notEqual((await orderRow(order.id)).payment_status, 'paid');
  });

  test('a payment for less than the order total is not taken as payment', async () => {
    const { order, reference } = await orderAwaitingPayment();
    await webhook(chargeSuccess({ reference, amountGhs: 1, orderId: order.id }));
    assert.notEqual((await orderRow(order.id)).payment_status, 'paid');
  });

  test('payment page opened twice, paid on the first: the order is still marked paid', async () => {
    const { order, reference: first } = await orderAwaitingPayment();
    const { body: second } = await startPayment(order.id);
    assert.notEqual(second.reference, first);
    await webhook(chargeSuccess({ reference: first, amountGhs: money(order.total), orderId: order.id }));
    assert.equal((await orderRow(order.id)).payment_status, 'paid');
  });
});

// ── The verify fallback ──────────────────────────────────────────────
describe('checking a payment on return from Paystack', { skip }, () => {
  async function verify(reference) {
    const res = await fetch(`${base}/api/checkout/verify/${encodeURIComponent(reference)}`);
    return res.status;
  }

  test("marks the order paid when Paystack confirms it", async () => {
    const { order, reference } = await orderAwaitingPayment();
    paystack.transactions.set(reference, chargeSuccess({ reference, amountGhs: money(order.total), orderId: order.id }).data);
    assert.equal(await verify(reference), 200);
    assert.equal((await orderRow(order.id)).payment_status, 'paid');
  });

  test('coming back before the webhook does the whole confirmation, and the webhook then adds nothing', async () => {
    const { order, reference } = await orderAwaitingPayment();
    const charge = chargeSuccess({ reference, amountGhs: money(order.total), orderId: order.id });
    paystack.transactions.set(reference, charge.data);
    await verify(reference);
    await webhook(charge);
    const { rows } = await db.query('SELECT status FROM order_status_history WHERE order_id = $1 ORDER BY id', [order.id]);
    assert.deepEqual(rows.map(r => r.status), ['paid', 'processing']);
  });

  test('does not mark it paid for less than the total', async () => {
    const { order, reference } = await orderAwaitingPayment();
    paystack.transactions.set(reference, chargeSuccess({ reference, amountGhs: 1, orderId: order.id }).data);
    await verify(reference);
    assert.notEqual((await orderRow(order.id)).payment_status, 'paid');
  });
});
