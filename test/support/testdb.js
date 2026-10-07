// test/support/testdb.js
//
// A throwaway database for one test file, built from sql/schema.sql and
// dropped afterwards. TEST_DATABASE_URL points at a PostgreSQL server; the
// tests connect to it only to create and drop their own database. Only a
// server on this machine is accepted (CI runs one in a container), so a test
// can never reach the live database.

import { readFileSync } from 'node:fs';
import pg from 'pg';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Why database tests can't run here, or null when they can. */
export function skipReason() {
  if (!ADMIN_URL) return 'TEST_DATABASE_URL is not set';
  const host = new URL(ADMIN_URL).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Refusing to test against ${host}: only a local PostgreSQL server is allowed`);
  return null;
}

async function withAdmin(fn) {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates `name` from sql/schema.sql and returns its connection string. */
export async function createTestDatabase(name) {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Bad test database name: ${name}`);
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name}`);
    await c.query(`CREATE DATABASE ${name}`);
  });
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8'));
  } finally {
    await client.end();
  }
  return url.toString();
}

export async function dropTestDatabase(name) {
  await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}
