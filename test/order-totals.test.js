// test/order-totals.test.js
//
// orderTotals in src/utils/pricing.js: tax, store credit and loyalty points,
// as an order is charged. The storefront's checkout shows the same function's
// result, so these rules are also what the customer sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { orderTotals } from '../src/utils/pricing.js';

const base = { subtotal: 200, shipping: 30, taxRatePercent: 12.5 };

test('tax is on the subtotal only, and adds to the total', () => {
  assert.deepEqual(orderTotals(base), { tax: 25, credit: 0, points: 0, pointsGhs: 0, maxPoints: 0, total: 255 });
});

test('the bundle saving and coupon come off before credit and points', () => {
  const t = orderTotals({ ...base, bundleDiscount: 50, couponDiscount: 20 });
  assert.equal(t.total, 255 - 50 - 20);
});

test('store credit is capped at the balance and at the total', () => {
  assert.equal(orderTotals({ ...base, creditRequested: 100, creditAvailable: 40 }).credit, 40);
  const all = orderTotals({ ...base, creditRequested: 1000, creditAvailable: 1000 });
  assert.equal(all.credit, 255);
  assert.equal(all.total, 0);
});

test('points come off after credit, at the redeem rate', () => {
  const t = orderTotals({ ...base, creditRequested: 55, creditAvailable: 55, pointsRequested: 500, pointsBalance: 500 });
  assert.equal(t.points, 500);
  assert.equal(t.pointsGhs, 50);
  assert.equal(t.total, 255 - 55 - 50);
});

test('fewer points than the minimum redeem nothing', () => {
  const typed = orderTotals({ ...base, pointsRequested: 50, pointsBalance: 500 });
  assert.equal(typed.points, 0);
  assert.equal(typed.total, 255);
  // A small order that can only take 80 points also redeems none.
  const small = orderTotals({ subtotal: 8, shipping: 0, taxRatePercent: 0, pointsRequested: 500, pointsBalance: 500 });
  assert.equal(small.maxPoints, 80);
  assert.equal(small.points, 0);
  assert.equal(small.total, 8);
});

test('points are whole, and never more than the balance or the total allows', () => {
  assert.equal(orderTotals({ ...base, pointsRequested: 150.7, pointsBalance: 500 }).points, 150);
  assert.equal(orderTotals({ ...base, pointsRequested: 5000, pointsBalance: 300 }).points, 300);
  assert.equal(orderTotals({ ...base, pointsRequested: 99999, pointsBalance: 99999 }).maxPoints, 2550);
});

test('missing, negative or text amounts are read safely', () => {
  const t = orderTotals({ ...base, taxRatePercent: '12.5', creditRequested: undefined, creditAvailable: 100, pointsRequested: -5, pointsBalance: 500 });
  assert.deepEqual([t.tax, t.credit, t.points, t.total], [25, 0, 0, 255]);
});

test('tax rounds the same way for any rate', () => {
  // subtotal × 15 / 100 and subtotal × 0.15 can round to different pesewas;
  // the function always uses the latter, as the server always has.
  assert.equal(orderTotals({ subtotal: 1.5, shipping: 0, taxRatePercent: 15 }).tax, +(1.5 * 0.15).toFixed(2));
});
