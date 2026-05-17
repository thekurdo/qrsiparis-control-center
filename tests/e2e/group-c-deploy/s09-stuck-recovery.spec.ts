/**
 * Scenario S9 — Stuck Deployment Recovered by Cron
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * Pre-seeds a deployment row directly in `in_progress` with a `started_at`
 * timestamp 35 minutes in the past (clearly past the 30-min threshold the
 * cron uses). Drops a fake BullMQ job under the same id so the test can
 * verify the cron sweeps Redis too. Then invokes
 * `runStuckRecovery()` from `@/lib/crons/deployment-stuck-recovery` and
 * asserts:
 *
 *   1. The deployment row flipped to `status='failed'`,
 *      `error_code='STUCK_TIMEOUT'`, `error_message` populated,
 *      `completed_at` stamped.
 *   2. The BullMQ job (key `bull:deployments:<deploymentId>`) is removed
 *      from Redis (and the queue's wait/active lists).
 *   3. An audit row `deployment.stuck_recovered` exists, entity_id =
 *      deployment id, metadata.thresholdMinutes = 30, metadata.errorCode
 *      = 'STUCK_TIMEOUT'.
 *   4. Idempotency: a second invocation does NOT write another audit row
 *      and does NOT mutate the already-failed row's columns (we capture
 *      the completed_at + error_message before re-run, then compare).
 *
 * --- WHY DIRECT IMPORT INSTEAD OF AN HTTP ENDPOINT ---
 * The control center has no `/api/internal/crons/[name]/trigger` route
 * (the cron scheduler itself is V1.5, see `src/app/(panel)/sistem/cron/
 * page.tsx`). Playwright's TS loader DOES honour the project's
 * `tsconfig.json` `paths` mapping, so `import { runStuckRecovery } from
 * '@/lib/crons/deployment-stuck-recovery'` resolves correctly and the
 * cron runs in-process against the same Postgres + Redis the dev server
 * + worker use. This is simpler and faster than spinning a child process
 * or HTTP round-trip.
 *
 * --- WHY 35 MINUTES INSTEAD OF 31 ---
 * The cron's threshold is `started_at < NOW() - INTERVAL '30 minutes'`.
 * A 35-minute backdate gives a 5-minute cushion against:
 *   - clock skew between the test process and Postgres (in CI containers
 *     this can be ~1-2s),
 *   - the test's seed -> cron call window (sub-second normally, but
 *     defensive against a slow VM).
 * 35min is still cheap to compute (no real time elapses) and unambiguous.
 *
 * --- WHY WE DON'T RACE THE WORKER's setInterval RECOVERY ---
 * `src/workers/deployment-worker.ts` has its own 60-second setInterval
 * that performs the same UPDATE. Worst case it fires during our test and
 * flips the row before our `runStuckRecovery()` call. The cron's own
 * idempotency guard (`UPDATE ... WHERE status='in_progress' RETURNING id`
 * + `if (updated.length === 0) continue`) handles that case by skipping
 * the audit write. But because the worker's interval is 60s and our
 * test's seed -> trigger cycle is sub-second, the cron almost always
 * wins. We still assert audit count `>= 1` rather than `=== 1` to be
 * resilient against a worst-case worker tick exactly when we ran (in
 * which case our cron's first run gets 0 audits, but a prior worker
 * audit isn't written because the worker's recovery path uses
 * `error_code='WORKER_STUCK'` not 'STUCK_TIMEOUT' and writes no audit).
 * In practice this scenario only ever produces ONE audit row from our
 * cron, because the worker's setInterval doesn't audit at all.
 */

import { test, expect } from '@playwright/test';
import IORedis from 'ioredis';

import { runStuckRecovery } from '@/lib/crons/deployment-stuck-recovery';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';
import { createServer } from '../fixtures/server.fixture';
import { createTenant } from '../fixtures/tenant.fixture';

test.setTimeout(60_000);

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:16379';

/** Count keys matching `bull:deployments:<deploymentId>` (exact-id hash). */
async function bullJobKeyExists(deploymentId: string): Promise<boolean> {
  const redis = new IORedis(REDIS_URL, { lazyConnect: true });
  try {
    await redis.connect();
    const exists = await redis.exists(`bull:deployments:${deploymentId}`);
    return exists === 1;
  } finally {
    redis.disconnect();
  }
}

/**
 * Returns whether the job id appears in any of BullMQ's state lists
 * (wait/active/delayed/prioritized/failed/completed). After
 * `job.remove()` it should be in none.
 */
async function bullJobAnywhere(deploymentId: string): Promise<{
  inWait: boolean;
  inActive: boolean;
  inFailed: boolean;
  hashExists: boolean;
}> {
  const redis = new IORedis(REDIS_URL, { lazyConnect: true });
  try {
    await redis.connect();
    const [inWait, inActive, inFailed, hashExists] = await Promise.all([
      redis.lpos('bull:deployments:wait', deploymentId).then((v) => v !== null),
      redis
        .lpos('bull:deployments:active', deploymentId)
        .then((v) => v !== null),
      redis
        .zscore('bull:deployments:failed', deploymentId)
        .then((v) => v !== null),
      redis
        .exists(`bull:deployments:${deploymentId}`)
        .then((v) => v === 1),
    ]);
    return { inWait, inActive, inFailed, hashExists };
  } finally {
    redis.disconnect();
  }
}

test.beforeEach(async () => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();
});

test('S9 stuck deployment recovered by cron: row flipped failed, BullMQ job removed, audit written, second run is idempotent', async () => {
  // ---- Seed phase: server + tenant + stuck deployment --------------------
  const server = await createServer();
  const tenant = await createTenant(server.id, {
    shortCode: 's09-stuck-test',
    domain: 's09-stuck.test.local',
  });

  // Backdate started_at by 35 minutes. The cron threshold is 30min; we
  // insert directly via rawQuery because the fixtures don't expose a
  // "create stuck deployment" factory (this is the only test that needs
  // one). We mirror the column subset that the runner / queue endpoint
  // would populate so referential integrity holds.
  const deploymentRows = await rawQuery<{ id: string }>(
    `INSERT INTO deployments (
       tenant_id, server_id, deployment_type, status,
       app_version, started_at
     ) VALUES ($1, $2, 'initial', 'in_progress', 'test-v1',
              NOW() - INTERVAL '35 minutes')
     RETURNING id`,
    [tenant.id, server.id],
  );
  expect(deploymentRows).toHaveLength(1);
  const deploymentId = deploymentRows[0]!.id;

  // ---- Seed phase: fake BullMQ job under the same id --------------------
  // We do NOT use `triggerDeployment(deploymentId)` here because that
  // would enqueue onto the `wait` list, where the running worker (task
  // `b2n3sd5kb` per the runbook) would pick it up before our cron runs,
  // start the real pipeline, and race the recovery flow. Instead, we
  // hand-roll a minimal BullMQ job hash and park it in the `delayed`
  // sorted set with a far-future score so the worker never grabs it.
  //
  // BullMQ's `Queue.getJob(id)` does `Job.fromId(queue, id)` which only
  // reads the `bull:deployments:<id>` hash — list/zset membership is not
  // required for reconstruction. Verified by a one-off node REPL run;
  // see commit log if this ever breaks. The cron's `removeDeploymentJob`
  // call then drives `job.remove()` which cleans the hash + zset entry
  // atomically.
  const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  try {
    await redis.hset(`bull:deployments:${deploymentId}`, {
      name: 'deploy',
      data: JSON.stringify({ deploymentId }),
      opts: JSON.stringify({ attempts: 1, removeOnFail: false }),
      timestamp: String(Date.now()),
    });
    // Also add it to a delayed sorted set so BullMQ.Job.fromId() can
    // reconstruct it. The score is far in the future so the worker never
    // pulls it. (BullMQ's getJob() ignores list/zset membership and just
    // reads the hash, so this is belt-and-braces.)
    await redis.zadd(
      'bull:deployments:delayed',
      String(Date.now() + 5_000_000),
      deploymentId,
    );

    expect(await bullJobKeyExists(deploymentId)).toBe(true);

    // ---- Run the cron (first invocation) ---------------------------------
    const r1 = await runStuckRecovery();
    expect(r1.recovered).toBe(1);

    // ---- Assert DB row flipped to failed --------------------------------
    const rowsAfter = await rawQuery<{
      status: string;
      error_code: string | null;
      error_message: string | null;
      completed_at: Date | null;
    }>(
      `SELECT status, error_code, error_message, completed_at
         FROM deployments WHERE id = $1`,
      [deploymentId],
    );
    expect(rowsAfter).toHaveLength(1);
    const dep = rowsAfter[0]!;
    expect(dep.status).toBe('failed');
    expect(dep.error_code).toBe('STUCK_TIMEOUT');
    expect(dep.error_message ?? '').toMatch(/in_progress|stuck|30dk/i);
    expect(dep.completed_at).not.toBeNull();

    // ---- Assert BullMQ job gone -----------------------------------------
    // The cron's `removeDeploymentJob` -> `job.remove()` drops both the
    // hash and the membership in any list/zset.
    const stateAfter = await bullJobAnywhere(deploymentId);
    expect(stateAfter.hashExists).toBe(false);
    expect(stateAfter.inWait).toBe(false);
    expect(stateAfter.inActive).toBe(false);
    expect(stateAfter.inFailed).toBe(false);

    // ---- Assert audit row written ----------------------------------------
    const auditRows1 = await rawQuery<{
      action: string;
      entity_id: string;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT action, entity_id, metadata
         FROM audit_log
        WHERE entity_id = $1 AND action = 'deployment.stuck_recovered'`,
      [deploymentId],
    );
    expect(auditRows1).toHaveLength(1);
    const audit = auditRows1[0]!;
    expect(audit.action).toBe('deployment.stuck_recovered');
    expect(audit.entity_id).toBe(deploymentId);
    expect(audit.metadata?.['thresholdMinutes']).toBe(30);
    expect(audit.metadata?.['errorCode']).toBe('STUCK_TIMEOUT');
    expect(audit.metadata?.['tenantId']).toBe(tenant.id);

    // ---- Idempotency: second invocation should be a no-op -------------
    // The cron's WHERE-clause filters on `status='in_progress'`. After
    // run #1 the row is `status='failed'`, so run #2 selects 0 rows and
    // exits early.
    const r2 = await runStuckRecovery();
    expect(r2.recovered).toBe(0);

    // No new audit row.
    const auditRows2 = await rawQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM audit_log
        WHERE entity_id = $1 AND action = 'deployment.stuck_recovered'`,
      [deploymentId],
    );
    expect(auditRows2[0]!.count).toBe('1');

    // Row columns unchanged.
    const rowsAfter2 = await rawQuery<{
      status: string;
      error_code: string | null;
      error_message: string | null;
      completed_at: Date | null;
    }>(
      `SELECT status, error_code, error_message, completed_at
         FROM deployments WHERE id = $1`,
      [deploymentId],
    );
    expect(rowsAfter2[0]!.status).toBe('failed');
    expect(rowsAfter2[0]!.error_code).toBe('STUCK_TIMEOUT');
    expect(rowsAfter2[0]!.error_message).toBe(dep.error_message);
    expect(rowsAfter2[0]!.completed_at?.getTime()).toBe(
      dep.completed_at?.getTime(),
    );
  } finally {
    redis.disconnect();
  }
});

test('S9 fresh in_progress deployment (<30min) is NOT recovered', async () => {
  // Negative path: a deployment with started_at = NOW() - 5min must not
  // be touched. The cron's threshold gate prevents premature recovery
  // of legitimate long-running pipelines (image pull + cert issuance can
  // run 10-15min on prod, per the worker comments).
  const server = await createServer();
  const tenant = await createTenant(server.id, {
    shortCode: 's09-fresh-test',
    domain: 's09-fresh.test.local',
  });

  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO deployments (
       tenant_id, server_id, deployment_type, status,
       app_version, started_at
     ) VALUES ($1, $2, 'initial', 'in_progress', 'test-v1',
              NOW() - INTERVAL '5 minutes')
     RETURNING id`,
    [tenant.id, server.id],
  );
  const deploymentId = rows[0]!.id;

  const r = await runStuckRecovery();
  expect(r.recovered).toBe(0);

  const after = await rawQuery<{ status: string }>(
    `SELECT status FROM deployments WHERE id = $1`,
    [deploymentId],
  );
  expect(after[0]!.status).toBe('in_progress');

  const auditCount = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM audit_log
      WHERE entity_id = $1 AND action = 'deployment.stuck_recovered'`,
    [deploymentId],
  );
  expect(auditCount[0]!.count).toBe('0');
});
