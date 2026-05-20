/**
 * QrSiparis Control Center — BullMQ deployment worker entrypoint (Phase H6).
 *
 * Per Doc 18 + IMPL_NOTES:
 *   - Queue name: `deployments`
 *   - Concurrency 3, limiter 5/min, attempts 1, timeout 10min
 *   - Reads from Redis (REDIS_URL); writes deployment progress + log entries
 *     to PostgreSQL (deployments.log) and Redis pub/sub (deployment:{id}:log)
 *
 * Crash-recovery cron: every 60s we sweep `deployments` rows stuck in
 * `in_progress` for >30min and force-fail them. This catches the case
 * where the worker process died mid-pipeline (BullMQ marks the job stalled
 * and re-queues, but with attempts=1 we don't want that — we just stamp
 * the row failed and let the operator decide).
 *
 * SIGTERM is handled gracefully — `worker.close()` waits for the
 * currently-running jobs to finish (or hit their 10-min timeout) before
 * exiting. Coolify's deploy lifecycle gives us up to 30s for graceful
 * shutdown which is plenty for typical jobs but not for a mid-pipeline
 * one — the crash recovery cron will catch any orphans.
 */

import { Worker } from 'bullmq';
import { and, eq, lt } from 'drizzle-orm';
import IORedis from 'ioredis';

import { db } from '@/db/client';
import { deployments } from '@/db/schema';
import { executeDeployment } from '@/lib/deploy/runner';

const REDIS_URL = process.env['REDIS_URL'];
if (!REDIS_URL) {
  throw new Error('[deploy.worker] REDIS_URL is required');
}

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

export const deploymentWorker = new Worker(
  'deployments',
  async (job) => {
    const { deploymentId } = job.data as { deploymentId: string };
    if (!deploymentId) throw new Error('deploymentId required');
    await executeDeployment(deploymentId);
  },
  {
    connection,
    concurrency: 3,
    limiter: { max: 5, duration: 60_000 },
    stalledInterval: 600_000,
    maxStalledCount: 1,
  },
);

deploymentWorker.on('failed', (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[deploy.failed] job=${job?.id} err=${err.message}`);
});

deploymentWorker.on('completed', (job) => {
  // eslint-disable-next-line no-console
  console.info(`[deploy.completed] job=${job?.id}`);
});

// eslint-disable-next-line no-console
console.info('[deploy.worker] started, concurrency=3, limiter=5/min');

// Crash recovery: every 60s, mark deployments stuck >30min as failed.
// Why 30min: pipelines can legitimately take 5-15min for initial deploys
// (image pull + cert issuance dominate); 30min is well past the worst-case
// happy path and signals worker death.
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const stuck = await db
      .update(deployments)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorCode: 'WORKER_STUCK',
        errorMessage: 'Marked failed after 30min in_progress',
      })
      .where(
        and(
          eq(deployments.status, 'in_progress'),
          lt(deployments.startedAt, cutoff),
        ),
      )
      .returning({ id: deployments.id });
    if (stuck.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[deploy.recovery] marked ${stuck.length} stuck deploys as failed`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[deploy.recovery] error:', err);
  }
}, 60_000);

process.on('SIGTERM', async () => {
  // eslint-disable-next-line no-console
  console.info('[deploy.worker] SIGTERM, draining...');
  await deploymentWorker.close();
  process.exit(0);
});
