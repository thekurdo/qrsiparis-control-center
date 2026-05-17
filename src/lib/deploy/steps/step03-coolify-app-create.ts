/**
 * Step 03 — COOLIFY_APP_CREATE.
 *
 * Forward: ask Coolify to create an application bound to the tenant's
 * shortCode + domain + assigned server. Stamps the returned UUID onto
 * `ctx.coolifyUuid` so step 06 can deploy it and the runner can persist
 * it to `tenants.container_name` (Phase H7+ wiring).
 *
 * Rollback: best-effort `deleteApp(uuid)`. We swallow errors because the
 * surrounding rollback loop already logs warnings and we want every
 * subsequent rollback to still run.
 *
 * Idempotency: if `ctx.coolifyUuid` is already set (retried pipeline),
 * skip the create call and reuse it.
 */

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

export const step03CoolifyAppCreate: PipelineStep = {
  name: 'COOLIFY_APP_CREATE',
  async forward(ctx) {
    if (ctx.coolifyUuid) {
      ctx.log('info', `idempotent skip — coolifyUuid=${ctx.coolifyUuid} already set`);
      return;
    }
    try {
      const app = await ctx.coolifyClient.createApp({
        name: ctx.tenant.shortCode,
        domain: ctx.tenant.domain,
        serverUuid: ctx.server.id,
        dockerImage: ctx.appVersion ?? 'qrsiparis-app:latest',
        envVars: ctx.envVars ?? {},
      });
      ctx.coolifyUuid = app.uuid;
      ctx.containerName = ctx.containerName ?? `rest-${ctx.tenant.shortCode}`;
      ctx.log('info', `coolify app created uuid=${app.uuid}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new PipelineError(ERROR_CODES.API_ERROR, `Coolify createApp failed: ${msg}`);
    }
  },
  async rollback(ctx) {
    if (!ctx.coolifyUuid) return;
    try {
      await ctx.coolifyClient.deleteApp(ctx.coolifyUuid);
      ctx.log('info', `coolify app deleted uuid=${ctx.coolifyUuid}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log('warn', `coolify deleteApp failed: ${msg}`);
    }
  },
};
