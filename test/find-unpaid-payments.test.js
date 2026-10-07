// test/find-unpaid-payments.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchPayments } from '../scripts-find-unpaid-payments.mjs';

const order = { id: 41, order_number: 'UP-20261001-AB12C', total: '255.00', created_at: new Date('2026-10-01') };
const charge = (fields) => ({ currency: 'GHS', amount: 25500, paid_at: '2026-10-01T10:00:00Z', metadata: { order_id: 41 }, ...fields });

test("a payment under the order's first reference is found", () => {
  const [row] = matchPayments([order], [charge({ reference: 'UP-20261001-AB12C' })]);
  assert.equal(row.order, 'UP-20261001-AB12C');
  assert.equal(row.matchedBy, 'reference');
  assert.equal(row.covers, 'yes');
  assert.equal(row.paidGhs, 255);
});

test('a payment under a retry reference is found', () => {
  const [row] = matchPayments([order], [charge({ reference: 'UP-20261001-AB12C-Rlz3k9q' })]);
  assert.equal(row.matchedBy, 'reference');
});

test('a payment that only names the order in its metadata is flagged for a closer look', () => {
  const [row] = matchPayments([order], [charge({ reference: 'something-else' })]);
  assert.match(row.matchedBy, /check by hand/);
});

test("other orders' payments are ignored", () => {
  assert.deepEqual(matchPayments([order], [charge({ reference: 'UP-20261001-ZZ99Z', metadata: { order_id: 7 } })]), []);
});

test('a short or foreign-currency payment is marked as not covering the order', () => {
  const [short] = matchPayments([order], [charge({ reference: 'UP-20261001-AB12C', amount: 100 })]);
  assert.match(short.covers, /^NO: GHS 1$/);
  const [usd] = matchPayments([order], [charge({ reference: 'UP-20261001-AB12C', currency: 'USD' })]);
  assert.match(usd.covers, /^NO: USD/);
});
