'use strict';
const { Pool, types } = require('pg');

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone shifting) and
// NUMERIC as JS numbers (values here are rupee amounts well within range).
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
const log = require('./logger');
const { AppError } = require('./errors');
const migrations = require('./migrations');

let pool = null;

function connectionConfig() {
  // DATABASE_URL is standard; POSTGRES_URL is what some Vercel integrations inject.
  const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!raw) {
    throw new AppError(500, 'CONFIG_MISSING', 'Server is not configured: DATABASE_URL is missing.');
  }
  const cfg = {
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  };
  if (process.env.DB_SSL_NO_VERIFY === 'true') {
    // Needed for providers that use a private CA (e.g. some Supabase poolers).
    // Encryption is kept; only certificate-chain verification is relaxed.
    const url = new URL(raw);
    url.searchParams.delete('sslmode');
    cfg.connectionString = url.toString();
    cfg.ssl = { rejectUnauthorized: false };
  } else {
    cfg.connectionString = raw;
  }
  return cfg;
}

function getPool() {
  if (!pool) {
    pool = new Pool(connectionConfig());
    pool.on('error', (err) => log.error('pg_pool_error', { message: err.message }));
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

// Runs fn inside a transaction (no tenant context). Used for auth flows.
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Runs fn inside a transaction with the tenant set for Row-Level Security.
// set_config(..., true) is transaction-local, so it is safe with poolers.
async function withTenant(businessId, fn) {
  return tx(async (client) => {
    await client.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    return fn(client);
  });
}

let migrated = null;

async function runMigrations() {
  return tx(async (client) => {
    // Serialises concurrent cold starts; released automatically at COMMIT.
    await client.query('SELECT pg_advisory_xact_lock(727100001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    const applied = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
      applied.push(m.version);
    }
    if (applied.length) log.info('migrations_applied', { versions: applied });
    return applied;
  });
}

// Called before API requests; runs once per server instance.
function ensureMigrated() {
  if (process.env.AUTO_MIGRATE === 'false') return Promise.resolve();
  if (!migrated) {
    migrated = runMigrations().catch((err) => {
      migrated = null; // retry on the next request
      throw err;
    });
  }
  return migrated;
}

async function rlsStatus() {
  const { rows } = await query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  const r = rows[0] || {};
  return { enforced: !(r.rolsuper || r.rolbypassrls) };
}

async function close() {
  if (pool) await pool.end();
  pool = null;
  migrated = null;
}

module.exports = { query, tx, withTenant, ensureMigrated, runMigrations, rlsStatus, close };
