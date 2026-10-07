// test/product-import.test.js
//
// The admin's product CSV import, through the real route and a real
// (throwaway) database: products and variants are created from the file,
// Excel's "CSV UTF-8" files keep their first column, and a __proto__ header
// is just a column.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDatabase, dropTestDatabase, skipReason } from './support/testdb.js';

// false, not null: node:test treats `skip: null` as "skip".
const skip = skipReason() || false;
const DB_NAME = `urbanpulse_test_import_${process.pid}`;

// Set before the app loads: no .env file, no mail or SMS.
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: 'test/support/no-such.env',
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-only-jwt-secret',
  SMTP_HOST: '',
  SMS_API_KEY: '',
  SENTRY_DSN: '',
});

let server;
let base;
let db;
let adminToken;

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = await createTestDatabase(DB_NAME);

  const express = (await import('express')).default;
  ({ pool: db } = await import('../src/db/index.js'));
  const { signAccess } = await import('../src/middleware/auth.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const adminRoutes = (await import('../src/routes/admin.js')).default;

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const { rows: [admin] } = await db.query(
    "INSERT INTO users (email, name, role) VALUES ('import-admin@example.test', 'Import Admin', 'admin') RETURNING id, role",
  );
  adminToken = signAccess(admin);
});

after(async () => {
  if (skip) return;
  server?.close();
  await db?.end();
  await dropTestDatabase(DB_NAME);
});

async function importCsv(text) {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), 'products.csv');
  const res = await fetch(`${base}/api/admin/products/import`, {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: form,
  });
  return { status: res.status, body: await res.json() };
}

const productBySlug = async (slug) =>
  (await db.query('SELECT id, name, price FROM products WHERE slug = $1', [slug])).rows[0];

test('a CSV creates the product and its variants', { skip }, async () => {
  const res = await importCsv(
    'slug,name,price,category,sku,size,color,stock\n'
    + 'import-tee,Import Tee,120,Tops,IT-S,S,Gold,4\n'
    + 'import-tee,Import Tee,120,Tops,IT-M,M,Gold,0\n',
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { created: 1, updated: 0, skipped: [] });

  const product = await productBySlug('import-tee');
  assert.equal(product.name, 'Import Tee');
  assert.equal(Number(product.price), 120);
  const { rows } = await db.query(
    'SELECT sku, size, stock FROM product_variants WHERE product_id = $1 ORDER BY sku', [product.id],
  );
  assert.deepEqual(rows, [{ sku: 'IT-M', size: 'M', stock: 0 }, { sku: 'IT-S', size: 'S', stock: 4 }]);
});

test("Excel's CSV UTF-8 files keep their first column", { skip }, async () => {
  // Excel starts these files with a byte order mark. If it stays on the
  // first header, "slug" is never found and the slug is made from the name.
  const res = await importCsv('﻿slug,name,price,category\r\nexcel-2026,Excel Jacket,400,Outerwear\r\n');
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);
  assert.ok(await productBySlug('excel-2026'), 'saved under its own slug');
  assert.equal(await productBySlug('excel-jacket'), undefined, 'not under a slug made from the name');
});

test('a __proto__ header is just a column', { skip }, async () => {
  const res = await importCsv('slug,__proto__,name,price\nproto-check,anything,Proto Check,10\n');
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);
  assert.equal((await productBySlug('proto-check')).name, 'Proto Check');
  assert.equal({}.anything, undefined);
});
