import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// pg-connection-string emits a deprecation warning whenever the connection
// string's own `sslmode` param is 'prefer', 'require', or 'verify-ca' (all
// three become aliases for 'verify-full' in a future major version) — this
// fires purely from parsing the string, regardless of the explicit `ssl`
// option below. Neon's generated connection strings commonly include
// `sslmode=require`, which is exactly one of the flagged values, so swapping
// it for a different sslmode wouldn't silence the warning. Stripping the
// param here makes TLS negotiation depend solely on the explicit `ssl` option,
// so the warning can't fire regardless of what DATABASE_URL contains.
function connectionStringWithoutSslMode(raw) {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('sslcert');
    url.searchParams.delete('sslkey');
    url.searchParams.delete('sslrootcert');
    return url.toString();
  } catch {
    return raw;
  }
}

export const pool = new Pool({
  connectionString: connectionStringWithoutSslMode(process.env.DATABASE_URL),
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
  process.exit(-1);
});

export const query = (text, params) => pool.query(text, params);

export const tx = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
