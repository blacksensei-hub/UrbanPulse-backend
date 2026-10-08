// test/error-handler.test.js
//
// What clients are told when a request fails. Errors raised on purpose keep
// their message; a crash (a database error, a TypeError) is logged and the
// client gets a generic one. Sign-up and sign-in say which field to fix, and
// validation details never carry back what was typed.
// No database: the auth checks fail before any query runs.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

// Set before the app loads: no .env file, and a database nobody listens on, so
// a query by mistake fails here instead of reaching a real one.
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: 'test/support/no-such.env',
  DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  JWT_SECRET: 'test-only-jwt-secret',
  SMTP_HOST: '',
  SMS_API_KEY: '',
  SENTRY_DSN: '',
});

let server;
let base;
let GENERIC_ERROR;

before(async () => {
  const express = (await import('express')).default;
  const multer = (await import('multer')).default;
  const { HttpError, badRequest } = await import('../src/utils/helpers.js');
  const handler = await import('../src/middleware/errorHandler.js');
  GENERIC_ERROR = handler.GENERIC_ERROR;
  const authRoutes = (await import('../src/routes/auth.js')).default;

  const app = express();
  app.use(express.json());
  app.get('/bad-request', () => {
    throw badRequest('Coupon has expired', [{ type: 'field', path: 'coupon_code', msg: 'Coupon has expired', value: 'SAVE10', location: 'body' }]);
  });
  app.get('/deliberate-500', () => { throw new HttpError(500, 'Code generation failed — please try again'); });
  app.get('/disabled', () => { throw Object.assign(new Error('This feature is currently disabled'), { status: 503 }); });
  app.get('/crash', () => { throw new TypeError("Cannot read properties of undefined (reading 'id')"); });
  app.get('/db-error', () => { throw Object.assign(new Error('relation "orders" does not exist'), { code: '42P01' }); });
  app.get('/hidden-5xx', () => { throw Object.assign(new Error('upstream detail'), { status: 502, expose: false }); });
  app.get('/too-large', () => { throw new multer.MulterError('LIMIT_FILE_SIZE'); });
  app.post('/echo', (req, res) => res.json(req.body));
  app.use('/api/auth', authRoutes);
  app.use(handler.errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

async function call(path, { body, raw } = {}) {
  const res = await fetch(`${base}${path}`, body === undefined && raw === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('errors raised on purpose keep their message and details, minus submitted values', async () => {
  assert.deepEqual(await call('/bad-request'), { status: 400, body: { error: 'Coupon has expired', details: [{ path: 'coupon_code', msg: 'Coupon has expired' }] } });
  assert.deepEqual(await call('/deliberate-500'), { status: 500, body: { error: 'Code generation failed — please try again' } });
  assert.deepEqual(await call('/disabled'), { status: 503, body: { error: 'This feature is currently disabled' } });
});

test('a crash is a 500 with a generic message, never its own', async () => {
  for (const path of ['/crash', '/db-error']) {
    assert.deepEqual(await call(path), { status: 500, body: { error: GENERIC_ERROR } }, path);
  }
  assert.deepEqual(await call('/hidden-5xx'), { status: 502, body: { error: GENERIC_ERROR } });
});

test('a rejected upload is a 400 that says why', async () => {
  assert.deepEqual(await call('/too-large'), { status: 400, body: { error: 'File too large' } });
});

test('a malformed JSON body is a 400, not a crash', async () => {
  const { status, body } = await call('/echo', { raw: '{"a":' });
  assert.equal(status, 400);
  assert.notEqual(body.error, GENERIC_ERROR);
});

test('sign-up and sign-in say which field to fix', async () => {
  const signUp = (fields) => call('/api/auth/register', { body: { name: 'Ama', email: 'ama@example.test', password: 'long-enough-1', ...fields } });
  assert.equal((await signUp({ email: 'not-an-email' })).body.error, 'Enter a valid email address.');
  assert.equal((await signUp({ name: '' })).body.error, 'Enter your name, up to 100 characters.');
  const signIn = await call('/api/auth/login', { body: { email: 'ama@example.test' } });
  assert.deepEqual([signIn.status, signIn.body.error], [400, 'Enter your password.']);
});

// The auth limiter allows 5 tries per window, and this file makes 4.
test('a sign-up with a short password never gets the password back', async () => {
  const password = 'Pw7-xQz';
  const { status, body } = await call('/api/auth/register', { body: { name: 'Ama', email: 'ama@example.test', password } });
  assert.equal(status, 400);
  assert.equal(body.error, 'Use at least 8 characters for your password.');
  assert.deepEqual(body.details, [{ path: 'password', msg: 'Use at least 8 characters for your password.' }]);
  assert.ok(!JSON.stringify(body).includes(password), 'the reply echoes the password');
});
