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

import { CoolifyApiError } from '@/types/coolify';

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
      const r = await ctx.coolifyClient.deployApp(ctx.coolifyUuid);
      ctx.coolifyDeploymentUuid = r.deployment_uuid;
      ctx.log('info', `deploy issued deployment_uuid=${r.deployment_uuid}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new PipelineError(ERROR_CODES.CONTAINER_START_FAILED, `deployApp call failed: ${msg}`);
    }

    let finalStatus;
    try {
      finalStatus = await ctx.coolifyClient.pollDeployment(
        ctx.coolifyDeploymentUuid!,
        DEPLOY_POLL_TIMEOUT_MS,
      );
    } catch (e) {
      if (e instanceof CoolifyApiError && e.coolifyCode === 'COOLIFY_POLL_TIMEOUT') {
        throw new PipelineError(
          ERROR_CODES.CONTAINER_START_TIMEOUT,
          `Deployment ${ctx.coolifyDeploymentUuid} did not finish within ${DEPLOY_POLL_TIMEOUT_MS}ms`,
        );
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new PipelineError(ERROR_CODES.CONTAINER_START_FAILED, `Poll failed: ${msg}`);
    }

    if (finalStatus !== 'success') {
      throw new PipelineError(
        ERROR_CODES.CONTAINER_START_FAILED,
        `Deployment ended with status=${finalStatus}`,
      );
    }
    ctx.log('info', `container started successfully`);
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
