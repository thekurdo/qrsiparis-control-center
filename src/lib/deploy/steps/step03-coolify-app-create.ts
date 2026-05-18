/**
 * Step 03 — COOLIFY_APP_CREATE.
 *
 * Forward: ask the real Coolify v4 API to create a Docker Compose
 * application for this tenant. Coolify provisions the Traefik labels
 * (so SSL + routing are automatic) and returns an app UUID we use for
 * the deploy + status calls in steps 06 and 07.
 *
 * The compose YAML for this tenant was generated in step02 and lives
 * on `ctx.tenantComposeYaml`. The Coolify server / project UUIDs come
 * from environment (`COOLIFY_PROJECT_UUID`, `COOLIFY_SERVER_UUID`) —
 * for V1 we run a single VPS with a single project, so these are
 * static config. V1.5 will look them up via `GET /api/v1/servers`
 * once per server registered in our `servers` table.
 *
 * Rollback: best-effort `deleteApp(uuid)`. We swallow errors because
 * the surrounding rollback loop already logs warnings and we want every
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
    if (!ctx.tenantComposeYaml) {
      throw new PipelineError(
        ERROR_CODES.CONFIG_INVALID,
        'tenantComposeYaml missing — step02 should have generated it',
      );
    }

    const projectUuid = process.env['COOLIFY_PROJECT_UUID'];
    const serverUuid = process.env['COOLIFY_SERVER_UUID'];
    if (!projectUuid || !serverUuid) {
      throw new PipelineError(
        ERROR_CODES.API_ERROR,
        'COOLIFY_PROJECT_UUID and COOLIFY_SERVER_UUID env vars are required for Coolify v4 deploys',
      );
    }

    try {
      const result = await ctx.coolifyClient.createDockerComposeApp({
        name: `rest-${ctx.tenant.shortCode}`,
        projectUuid,
        serverUuid,
        environmentName: 'production',
        composeYaml: ctx.tenantComposeYaml,
        // Domain is routed via SERVICE_FQDN_APP_80 inside the compose YAML;
        // Coolify v4's dockercompose endpoint rejects an explicit `domains`
        // field ("This field is not allowed.")
        description: `Tenant ${ctx.tenant.shortCode} — ${ctx.tenant.restaurantName}`,
        instantDeploy: false,
      });
      ctx.coolifyUuid = result.uuid;
      ctx.containerName = ctx.containerName ?? `rest-${ctx.tenant.shortCode}`;
      ctx.log('info', `coolify app created uuid=${result.uuid} domains=${JSON.stringify(result.domains)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new PipelineError(ERROR_CODES.API_ERROR, `Coolify createDockerComposeApp failed: ${msg}`);
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
