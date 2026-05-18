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

const DEPLOY_POLL_TIMEOUT_MS = 90_000;

export const step06ContainerStart: PipelineStep = {
  name: 'CONTAINER_START',
  async forward(ctx) {
    if (!ctx.coolifyUuid) {
      throw new PipelineError(
        ERROR_CODES.CONTAINER_START_FAILED,
        'No coolifyUuid set — step 03 should have stamped it',
      );
    }
    try {
      // Coolify v4: triggerDeploy hits /api/v1/deploy?uuid=X.
      // (Legacy `deployApp` targets the WireMock E2E path; not used in prod.)
      const r = await ctx.coolifyClient.triggerDeploy(ctx.coolifyUuid, true);
      ctx.coolifyDeploymentUuid = r.deployment_uuid;
      ctx.log('info', `deploy issued deployment_uuid=${r.deployment_uuid}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new PipelineError(ERROR_CODES.CONTAINER_START_FAILED, `triggerDeploy call failed: ${msg}`);
    }

    // V1: instead of polling deployment-detail (Coolify v4 returns numeric IDs
    // in a deployments list which we'd need to map), poll the application
    // status until it reads "running" or we time out. This is the same
    // success criterion the operator UI uses.
    const start = Date.now();
    let lastStatus = '';
    while (Date.now() - start < DEPLOY_POLL_TIMEOUT_MS) {
      try {
        const app = await ctx.coolifyClient.getApp(ctx.coolifyUuid);
        lastStatus = String(app.status || '');
        if (lastStatus.startsWith('running')) {
          ctx.log('info', `container started successfully (status=${lastStatus})`);
          return;
        }
        if (lastStatus.startsWith('exited') || lastStatus.startsWith('failed')) {
          throw new PipelineError(
            ERROR_CODES.CONTAINER_START_FAILED,
            `Coolify reports app failed: status=${lastStatus}`,
          );
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
