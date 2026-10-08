// test/sentry-scrub.test.js
//
// What Sentry receives about the request behind a crash (src/utils/sentryScrub.js).
// Passwords, one-time codes, tokens and session cookies are blanked wherever
// they sit in the body, cookies, headers or query string; everything else is
// kept, so a report still shows what was sent. The last test runs the real
// @sentry/node with a transport that records instead of sending, so no DSN
// and no network are needed.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import * as Sentry from '@sentry/node';
import express from 'express';
import cookieParser from 'cookie-parser';

import { FILTERED, isSensitiveKey, scrubSentryEvent } from '../src/utils/sentryScrub.js';

const scrubbed = (request) => scrubSentryEvent({ request }).request;

test('sensitive keys are blanked at any depth, whatever their case', () => {
  const data = {
    email: 'ama@example.com',
    Password: 'hunter22',
    profile: {
      name: 'Ama',
      security: { current_password: 'old-pass', newPassword: 'new-pass', OTP: '123456' },
    },
    devices: [{ label: 'phone', refresh: 'r-1', totp: '654321' }],
    settings: { secret: 's', apiKey: 'k', challenge_token: 'jwt', id_token: 'google', cookie: 'c' },
  };
  assert.deepEqual(scrubbed({ data }).data, {
    email: 'ama@example.com',
    Password: FILTERED,
    profile: {
      name: 'Ama',
      security: { current_password: FILTERED, newPassword: FILTERED, OTP: FILTERED },
    },
    devices: [{ label: 'phone', refresh: FILTERED, totp: FILTERED }],
    settings: { secret: FILTERED, apiKey: FILTERED, challenge_token: FILTERED, id_token: FILTERED, cookie: FILTERED },
  });
});

test('a sensitive key loses its whole value, even an object', () => {
  // Paystack's webhook carries a reusable card authorization under this key.
  const data = { event: 'charge.success', data: { reference: 'UP-1', authorization: { authorization_code: 'AUTH_x', last4: '4081' } } };
  assert.deepEqual(scrubbed({ data }).data, { event: 'charge.success', data: { reference: 'UP-1', authorization: FILTERED } });
});

test('a JSON-text body is blanked field by field and stays JSON text', () => {
  const body = JSON.stringify({ email: 'ama@example.com', password: 'hunter22', nested: { code: '123456', qty: 2 } });
  const data = scrubbed({ data: body }).data;
  assert.equal(typeof data, 'string');
  assert.deepEqual(JSON.parse(data), { email: 'ama@example.com', password: FILTERED, nested: { code: FILTERED, qty: 2 } });
});

test('fields that only look close are kept', () => {
  const data = {
    coupon_code: 'SAVE10', referral_code: 'AMA123', zip: '00233', postcode: 'GA-1',
    pinned: true, name: 'Ama', note: 'Leave at the gate', items: [{ variant_id: 7, quantity: 2 }],
  };
  assert.deepEqual(scrubbed({ data }).data, data);
  for (const key of ['coupon_code', 'referral_code', 'country_code', 'pinned', 'author', 'footprint']) {
    assert.equal(isSensitiveKey(key), false, key);
  }
  for (const key of ['otp_code', 'backupCodes', 'totp_recovery_codes', 'verification_code', 'reset_token', 'PASSWD']) {
    assert.equal(isSensitiveKey(key), true, key);
  }
});

test('body text that is not JSON is dropped only when it names a sensitive field', () => {
  // Sentry cuts bodies off at 10 KB, which leaves invalid JSON.
  assert.equal(scrubbed({ data: '{"email":"a@b.c","password":"hunt...' }).data, FILTERED);
  const cut = '{"rows":[{"name":"Tee","price":120},{"name":"Cap...';
  assert.equal(scrubbed({ data: cut }).data, cut);
  assert.equal(scrubbed({ data: 'email=a%40b.c&new_password=x' }).data, FILTERED);
  assert.equal(scrubbed({ data: 'Content-Disposition: form-data; name="token"\r\n\r\nabc' }).data, FILTERED);
  assert.equal(scrubbed({ data: 'Content-Disposition: form-data; name="file"; filename="a.csv"' }).data,
    'Content-Disposition: form-data; name="file"; filename="a.csv"');
});

test('session cookies, the Authorization header and query secrets are blanked', () => {
  const request = scrubbed({
    method: 'GET',
    url: 'https://api.example.com/api/orders?page=2&token=abc#top',
    query_string: 'page=2&token=abc',
    headers: { 'content-type': 'application/json', authorization: 'Bearer abc', cookie: 'accessToken=a; theme=dark' },
    cookies: { accessToken: 'a', refreshToken: 'r', theme: 'dark' },
  });
  assert.deepEqual(request, {
    method: 'GET',
    url: `https://api.example.com/api/orders?page=2&token=${FILTERED}#top`,
    query_string: `page=2&token=${FILTERED}`,
    headers: { 'content-type': 'application/json', authorization: FILTERED, cookie: FILTERED },
    cookies: { accessToken: FILTERED, refreshToken: FILTERED, theme: 'dark' },
  });
});

test('events without a request pass through untouched', () => {
  const event = { message: 'job failed', extra: { order_id: 7 } };
  assert.equal(scrubSentryEvent(event), event);
  assert.deepEqual(event, { message: 'job failed', extra: { order_id: 7 } });
});

let server;
after(async () => {
  server?.close();
  await Sentry.close(2000);
});

test('a crash on sign-up reaches Sentry without the password or session cookies', async () => {
  const envelopes = [];
  Sentry.init({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    transport: () => ({
      send: async (envelope) => { envelopes.push(envelope); return {}; },
      flush: async () => true,
    }),
  });

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.post('/api/auth/register', () => { throw new Error('database went away'); });
  Sentry.setupExpressErrorHandler(app);
  app.use((_err, _req, res, _next) => res.status(500).json({ error: 'Something went wrong' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'accessToken=cookie-access; refreshToken=cookie-refresh; theme=dark',
      authorization: 'Bearer header-bearer',
    },
    body: JSON.stringify({ email: 'ama@example.com', password: 'hunter22', name: 'Ama', profile: { otp: '123456' } }),
  });
  assert.equal(res.status, 500);
  await Sentry.flush(2000);

  const events = envelopes.flatMap(([, items]) => items).filter(([header]) => header.type === 'event').map(([, event]) => event);
  assert.equal(events.length, 1);
  const { request } = events[0];
  // Sentry did capture the body and cookies, so the blanks below are the scrubber's work.
  assert.deepEqual(JSON.parse(request.data), { email: 'ama@example.com', password: FILTERED, name: 'Ama', profile: { otp: FILTERED } });
  assert.deepEqual(request.cookies, { accessToken: FILTERED, refreshToken: FILTERED, theme: 'dark' });
  assert.equal(request.headers.authorization, FILTERED);
  assert.equal(request.headers.cookie, FILTERED);

  const sent = JSON.stringify(envelopes);
  for (const secret of ['hunter22', '123456', 'cookie-access', 'cookie-refresh', 'header-bearer']) {
    assert.ok(!sent.includes(secret), `${secret} reached Sentry`);
  }
});
