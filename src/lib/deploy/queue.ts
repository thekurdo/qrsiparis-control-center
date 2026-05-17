/**
 * Deployment queue producer (Phase H6).
 *
 * Single BullMQ `Queue` instance for the `deployments` queue. The API
 * route (`POST /api/internal/deployments`) calls `triggerDeployment(id)`
 * after inserting the deployments row; the worker process consumes the
 * job, calls `executeDeployment(id)`, and updates the row.
 *
 * Design notes:
 *   - `jobId = deploymentId` so retries / idempotency rely on BullMQ's
 *     dedupe (a re-POST with the same id won't create a second job).
 *   - `attempts: 1` — pipelines are not safe to retry blindly; the
 *     operator decides whether to redeploy via the UI.
 *   - `removeOnComplete: { count: 100 }` — keep last 100 successful jobs
 *     in Redis for ops debugging; older are pruned.
 *   - `removeOnFail: false` — keep failed jobs forever (Redis is the
 *     audit trail). The DB row is the source of truth, but seeing the
 *     job in BullMQ Dashboard is useful during incidents.
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

let _connection: IORedis | null = null;
let _queue: Queue | null = null;

/**
 * Lazy queue — REDIS_URL is read at first call. Avoids crashing tests
 * that import this module without a Redis connection available.
 */
function getQueue(): Queue {
  if (_queue) return _queue;
  const url = process.env['REDIS_URL'];
  if (!url) {
    throw new Error('[deploy.queue] REDIS_URL is required');
  }
  _connection = new IORedis(url, { maxRetriesPerRequest: null });
  _queue = new Queue('deployments', { connection: _connection });
  return _queue;
}

/**
 * Enqueue a `deploy` job for the given deployment row id. The worker
 * picks it up, calls `executeDeployment(deploymentId)`, and persists
 * status updates.
 *
 * Caller MUST have already inserted the deployments row (status='pending')
 * before invoking this — the worker reads the row to discover deploy type
 * etc.
 */
export async function triggerDeployment(deploymentId: string): Promise<void> {
  await getQueue().add(
    'deploy',
    { deploymentId },
    {
      jobId: deploymentId,
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: false,
    },
  );
}

/**
 * Remove a queued/active/failed job by id. Used by the
 * `deployment-stuck-recovery` cron (Phase H11) to clean up the BullMQ
 * job record after force-failing the deployment row.
 *
 * Returns `true` if a job was found and removed, `false` if no job
 * existed for that id (e.g. the queue is empty because the worker
 * already processed and pruned it).
 *
 * Why we don't `await job.moveToFailed()` instead: the cron's source of
 * truth is the DB row, not BullMQ. Once we've stamped `status='failed'`
 * on the row, the job's existence in Redis is just clutter — `remove()`
 * is the cleanest way to drop it from the active/waiting list AND its
 * `bull:deployments:<id>` hash without re-running BullMQ's failure
 * handlers (which would re-emit `failed` events for an already-failed
 * deployment).
 *
 * Idempotency: safe to call multiple times. The second call hits the
 * `!job` path and returns false.
 */
export async function removeDeploymentJob(
  deploymentId: string,
): Promise<boolean> {
  const job = await getQueue().getJob(deploymentId);
  if (!job) return false;
  await job.remove();
  return true;
}
