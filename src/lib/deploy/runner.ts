/**
 * Deployment runner (Phase H6).
 *
 * Orchestrates one BullMQ job from job-pop to deployment row finalisation:
 *
 *   1. Set deployments.status = 'in_progress', stamp started_at.
 *   2. Load deployment, tenant, server rows.
 *   3. Build a PipelineContext (logging fan-out + scratch state).
 *   4. Dispatch on `deployment_type` to pick the step list.
 *   5. Run pipeline; on success stamp status='success' + duration.
 *      On failure stamp status='failed' + error_code + error_message.
 *
 * V1 only implements `initial`. The other four deploy types are stubbed
 * to a no-op success so the queue API remains usable from day one — real
 * step lists land in Phase H7 (config_update + app_update) and V1.5
 * (redeploy + rollback).
 *
 * Why a singleton Redis client here: the worker process re-uses one
 * connection for both BullMQ job consumption and pipeline log pub/sub.
 * Creating a second connection per job would multiply against
 * `maxRetriesPerRequest=null` semantics and saturate Redis on bursts.
 */

import { eq } from 'drizzle-orm';
import IORedis from 'ioredis';

import { db } from '@/db/client';
import { deployments, servers, tenants } from '@/db/schema';

import { createPipelineContext } from './context';
import { PipelineError, runPipeline, type PipelineStep } from './pipeline';
import { initialDeploySteps } from './steps';

let _redis: IORedis | null = null;

/**
 * Lazy singleton — REDIS_URL is read at first call so the module can be
 * imported in environments where Redis isn't required (e.g. unit tests).
 */
function getRedis(): IORedis {
  if (_redis) return _redis;
  const url = process.env['REDIS_URL'];
  if (!url) {
    throw new Error('[deploy.runner] REDIS_URL is required');
  }
  _redis = new IORedis(url, { maxRetriesPerRequest: null });
  return _redis;
}

/**
 * Drive one deployment through its pipeline. Called from the BullMQ
 * worker's job processor.
 *
 * Throws on terminal failure — BullMQ will mark the job failed (we use
 * attempts=1 so there's no auto-retry). The deployments row is stamped
 * with `status='failed'` + error_code/error_message before the throw so
 * the operator UI shows the right state even if the worker dies right
 * after.
 */
export async function executeDeployment(deploymentId: string): Promise<void> {
  const startTime = Date.now();

  // Mark in_progress as the very first thing — gives the SSE consumer
  // something to render even before the first step.start log.
  await db
    .update(deployments)
    .set({ status: 'in_progress', startedAt: new Date() })
    .where(eq(deployments.id, deploymentId));

  const deployment = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1)
    .then((r) => r[0]);
  if (!deployment) {
    throw new PipelineError(
      'DEPLOYMENT_NOT_FOUND',
      `Deployment ${deploymentId} not found`,
    );
  }

  const tenant = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, deployment.tenantId))
    .limit(1)
    .then((r) => r[0]);
  if (!tenant) {
    throw new PipelineError('TENANT_NOT_FOUND', 'Tenant missing');
  }

  const server = await db
    .select()
    .from(servers)
    .where(eq(servers.id, deployment.serverId))
    .limit(1)
    .then((r) => r[0]);
  if (!server) {
    throw new PipelineError('NO_SERVER', 'Server missing');
  }

  const ctx = createPipelineContext({
    deployment,
    tenant,
    server,
    redis: getRedis(),
  });

  try {
    let steps: PipelineStep[];
    switch (deployment.deploymentType) {
      case 'initial':
        steps = initialDeploySteps;
        break;
      // V1.5+ stubs — keep the queue contract usable without panicking.
      case 'config_update':
      case 'app_update':
      case 'redeploy':
      case 'rollback':
        steps = [];
        break;
      default:
        throw new PipelineError('INVALID_TYPE', 'Unknown deployment type');
    }

    if (steps.length === 0) {
      ctx.log(
        'warn',
        `${deployment.deploymentType} not implemented in V1; marking success no-op`,
      );
      await ctx.flushLogs();
      await db
        .update(deployments)
        .set({
          status: 'success',
          completedAt: new Date(),
          durationSeconds: 0,
        })
        .where(eq(deployments.id, deploymentId));
      return;
    }

    await runPipeline(steps, ctx);

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    ctx.durationSeconds = elapsed;
    await db
      .update(deployments)
      .set({
        status: 'success',
        completedAt: new Date(),
        durationSeconds: elapsed,
      })
      .where(eq(deployments.id, deploymentId));
  } catch (err) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const code = err instanceof PipelineError ? err.code : 'UNKNOWN_ERROR';
    const message = err instanceof Error ? err.message : String(err);

    await db
      .update(deployments)
      .set({
        status: 'failed',
        completedAt: new Date(),
        durationSeconds: elapsed,
        errorCode: code,
        errorMessage: message,
      })
      .where(eq(deployments.id, deploymentId));
    throw err;
  }
}
