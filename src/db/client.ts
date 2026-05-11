/**
 * QrSiparis Control Center — Drizzle PostgreSQL client (Phase H1).
 *
 * Singleton `pg.Pool` + Drizzle ORM. Read DATABASE_URL once at module load.
 * Both the Next.js app and the BullMQ worker import from this module so
 * connection pooling is shared (one pool per process).
 *
 * Pool sizing:
 *   - Default max=10. The Next.js process handles request-scoped queries
 *     plus a few long-lived SSE subscribers; the worker process handles up
 *     to 3 concurrent deploys (Doc 18 §14.1) plus cron jobs. 10 is a safe
 *     ceiling for a single VPS-01 PG host.
 *   - Override via PGPOOL_MAX env var when running under heavier load.
 *
 * Migration: Drizzle Kit reads schema.ts and writes migrations to
 * ./drizzle/migrations. The DB client does not auto-migrate; the runner
 * (`pnpm db:migrate`) is invoked from `instrumentation.ts` on app boot
 * and from `start-worker.ts` on worker boot (Phase H6 wires this up).
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema';

let _pool: Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

function readDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url || url.length === 0) {
    throw new Error(
      '[db/client] DATABASE_URL is not set. Set it in `.env` or the runtime environment.',
    );
  }
  return url;
}

function readPoolMax(): number {
  const raw = process.env['PGPOOL_MAX'];
  if (!raw) return 10;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[db/client] PGPOOL_MAX must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

/**
 * Lazily-initialised singleton pool. Safe under HMR (Next.js dev) because
 * we cache on the module scope which Node's require cache preserves.
 */
export function getPool(): Pool {
  if (_pool) return _pool;

  const config: PoolConfig = {
    connectionString: readDatabaseUrl(),
    max: readPoolMax(),
    // Prevent zombie connections during deploy worker restarts.
    idleTimeoutMillis: 30_000,
    // Fail fast if the DB host is unreachable instead of hanging the request.
    connectionTimeoutMillis: 10_000,
    // Application name shows up in `pg_stat_activity` for ops debugging.
    application_name: process.env['APP_NAME'] ?? 'qrsiparis-control-center',
  };

  _pool = new Pool(config);
  _pool.on('error', (err) => {
    // Background pool errors (idle client failures) — log but do not exit.
    // eslint-disable-next-line no-console
    console.error('[db/client] pool error:', err);
  });
  return _pool;
}

/**
 * Singleton Drizzle instance bound to the schema. Use this everywhere instead
 * of constructing ad-hoc clients.
 */
export function getDb(): NodePgDatabase<typeof schema> {
  if (_db) return _db;
  _db = drizzle(getPool(), { schema, casing: 'snake_case' });
  return _db;
}

/**
 * Convenience export — most call sites can `import { db } from '@/db/client'`.
 *
 * NOTE: Lazy via Proxy to avoid throwing at module-eval time when the env
 * isn't ready (e.g., running drizzle-kit which doesn't need the runtime
 * client). The first property access triggers `getDb()`.
 */
export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    const real = getDb();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

/**
 * Graceful shutdown — call from worker SIGTERM handler and from any test
 * harness that needs to release the pool deterministically.
 */
export async function closePool(): Promise<void> {
  if (!_pool) return;
  const pool = _pool;
  _pool = null;
  _db = null;
  await pool.end();
}

// Re-export schema for convenience (`import { tenants } from '@/db/client'`).
export * from './schema';
