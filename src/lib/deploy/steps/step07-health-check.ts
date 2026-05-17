/**
 * Step 07 — HEALTH_CHECK.
 *
 * Forward: ask Coolify what state the application is in. If `running`, we
 * consider the health check passed (Coolify itself runs the dockerfile
 * HEALTHCHECK and tracks restarts; querying the app status is a
 * lightweight proxy for "the container survived its readiness probe").
 *
 * Future enhancement (Phase H7+): also hit `https://{tenant.domain}/api/health`
 * directly to verify the user-facing path. For V1 the Coolify proxy
 * check is enough.
 *
 * Rollback: noop — health check is read-only.
 */

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

export const step07HealthCheck: PipelineStep = {
  name: 'HEALTH_CHECK',
  async forward(ctx) {
    if (!ctx.coolifyUuid) {
      throw new PipelineError(
        ERROR_CODES.HEALTH_CHECK_FAILED,
        'No coolifyUuid set — step 03 should have stamped it',
      );
    }
    try {
      const app = await ctx.coolifyClient.getApp(ctx.coolifyUuid);
      if (app.status !== 'running') {
        throw new PipelineError(
          ERROR_CODES.HEALTH_CHECK_FAILED,
          `Coolify reports app.status=${app.status} (expected 'running')`,
        );
      }
      ctx.log('info', `health check OK — coolify status=${app.status}`);
    } catch (e) {
      if (e instanceof PipelineError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new PipelineError(ERROR_CODES.HEALTH_CHECK_FAILED, `getApp failed: ${msg}`);
    }
  },
  async rollback() {
    /* noop — health check is read-only */
  },
};
