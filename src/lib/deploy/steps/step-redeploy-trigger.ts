/**
 * REDEPLOY_TRIGGER — used by the `redeploy` and `app_update` pipelines.
 *
 * Forward: call Coolify's `/api/v1/deploy?uuid=X&force=true` for the
 * tenant's existing application. Initial deploys do NOT use this step —
 * they go through step03 which uses `instant_deploy:true` so the deploy
 * is implicit.
 *
 * Rollback: noop. The subsequent poll step (step06) handles the failure
 * path; nothing to undo here.
 *
 * Idempotency: triggering a redeploy of an already-deploying app is a
 * no-op on Coolify's side (it logs a warning and ignores the second
 * call), so this step is safe to retry.
 */

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

export const stepRedeployTrigger: PipelineStep = {
  name: 'REDEPLOY_TRIGGER',
  async forward(ctx) {
    // Recover the tenant's existing Coolify application UUID. step03
    // stamps it onto ctx for the lifetime of one pipeline run, but a
    // standalone redeploy pipeline starts fresh — look up by app name
    // (`rest-${shortCode}` is the convention from step03).
    if (!ctx.coolifyUuid) {
      const expectedName = `rest-${ctx.tenant.shortCode}`;
      try {
        const apps = await ctx.coolifyClient.listApps();
        const match = apps.find((a) => a.name === expectedName);
        if (match) {
          ctx.coolifyUuid = match.uuid;
          ctx.log('info', `recovered coolifyUuid=${match.uuid} for ${expectedName}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.log('warn', `listApps lookup failed (will retry): ${msg}`);
      }
    }

    if (!ctx.coolifyUuid) {
      throw new PipelineError(
        ERROR_CODES.API_ERROR,
        `No Coolify app found for tenant ${ctx.tenant.shortCode}; cannot redeploy. Has this tenant been initially deployed?`,
      );
    }

    try {
      const r = await ctx.coolifyClient.triggerDeploy(ctx.coolifyUuid, true);
      ctx.coolifyDeploymentUuid = r.deployment_uuid;
      ctx.log('info', `redeploy triggered deployment_uuid=${r.deployment_uuid}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new PipelineError(ERROR_CODES.API_ERROR, `triggerDeploy failed: ${msg}`);
    }
  },
  async rollback(ctx) {
    ctx.log('info', 'REDEPLOY_TRIGGER rollback: noop (poll step handles failure path)');
  },
};
