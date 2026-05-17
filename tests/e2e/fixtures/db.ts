/**
 * DB helpers for E2E tests — runs against the dev Postgres container
 * (port 55432). Each test file calls `truncateAll()` in `beforeEach`
 * to start from a clean slate (operator_users preserved except `test-*`).
 *
 * Pool is shared across tests in the same worker; closed in global
 * teardown.
 */

import 'dotenv/config';
import pg from 'pg';

const url = process.env['DATABASE_URL'];
if (!url) {
  throw new Error('[e2e/db] DATABASE_URL is not set — check .env');
}

const pool = new pg.Pool({ connectionString: url, max: 5 });

/**
 * Wipe everything that tests mutate, preserving the seed admin operator
 * so the auth fixture can log in without re-seeding.
 *
 * RESTART IDENTITY CASCADE so id sequences don't drift across runs (the
 * fixtures rely on deterministic counters elsewhere; this keeps DB ids
 * stable too).
 */
export async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE audit_log, deployments, tenants, servers RESTART IDENTITY CASCADE`,
  );
  await pool.query(`DELETE FROM operator_users WHERE username LIKE 'test-%'`);
}

export async function rawQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const r = await pool.query<T>(sql, params);
  return r.rows;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
