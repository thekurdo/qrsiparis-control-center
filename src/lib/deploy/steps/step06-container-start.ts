/**
 * Step 06 — CONTAINER_START.
 *
 * Forward: tell Coolify to deploy the application we created in step 03,
 * then poll the deployment status until it reaches a terminal state. A
 * non-success terminal state raises `CONTAINER_START_FAILED`; exceeding
 * the poll window raises `CONTAINER_START_TIMEOUT`.
 *
 * Rollback: best-effort `stopApp(uuid)` so the container doesn't keep
 * consuming resources on a failed deploy.
 *
 * Idempotency: Coolify's deploy endpoint is idempotent for the "already
 * running, no config drift" case. For drift, it triggers a rolling
 * restart, also idempotent.
 */

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

const DEPLOY_POLL_TIMEOUT_MS = 180_000;
// Coolify reports a fresh dockerimage app as `exited:unhealthy` for a
// brief window between create and first healthy state. Don't treat that
// as a permanent failure — wait this long for it to clear.
const EXITED_GRACE_MS = 60_000;

export const step06ContainerStart: PipelineStep = {
  name: 'CONTAINER_START',
  async forward(ctx) {
    if (!ctx.coolifyUuid) {
      throw new PipelineError(
        ERROR_CODES.CONTAINER_START_FAILED,
        'No coolifyUuid set — step 03 should have stamped it',
      );
    }

    // Step 03 created the app with `instant_deploy: true` (Coolify v4
    // dockerimage endpoint), so the build/start is already underway.
    // We just poll the app status; no explicit triggerDeploy call needed.
    // (Calling it would race with the instant-deploy already running and
    // can return `deployment_uuid: undefined`.)

    const start = Date.now();
    let lastStatus = '';
    let firstExitedAt: number | null = null;
    while (Date.now() - start < DEPLOY_POLL_TIMEOUT_MS) {
      try {
        const app = await ctx.coolifyClient.getApp(ctx.coolifyUuid);
        lastStatus = String(app.status || '');
        if (lastStatus.startsWith('running')) {
          ctx.log('info', `container started successfully (status=${lastStatus})`);
          return;
        }
        if (lastStatus.startsWith('failed')) {
          throw new PipelineError(
            ERROR_CODES.CONTAINER_START_FAILED,
            `Coolify reports app failed: status=${lastStatus}`,
          );
        }
        if (lastStatus.startsWith('exited')) {
          firstExitedAt ??= Date.now();
          if (Date.now() - firstExitedAt > EXITED_GRACE_MS) {
            throw new PipelineError(
              ERROR_CODES.CONTAINER_START_FAILED,
              `Coolify reports app stuck in exited state for ${EXITED_GRACE_MS}ms: status=${lastStatus}`,
            );
          }
          ctx.log('info', `transient exited state (${lastStatus}) — will keep polling`);
        } else {
          firstExitedAt = null;
        }
      } catch (e) {
        if (e instanceof PipelineError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        ctx.log('warn', `getApp poll error (will retry): ${msg}`);
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new PipelineError(
      ERROR_CODES.CONTAINER_START_TIMEOUT,
      `Coolify app ${ctx.coolifyUuid} did not reach running state within ${DEPLOY_POLL_TIMEOUT_MS}ms (last status: ${lastStatus})`,
    );
  },
  async rollback(ctx) {
    if (!ctx.coolifyUuid) return;
    try {
      await ctx.coolifyClient.stopApp(ctx.coolifyUuid);
      ctx.log('info', `coolify app stopped uuid=${ctx.coolifyUuid}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log('warn', `coolify stopApp failed: ${msg}`);
    }
  },
};
