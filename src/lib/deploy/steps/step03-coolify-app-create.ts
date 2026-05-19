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
 * Post-create touch-ups (both defensive — log+continue on failure):
 *   1. POST `/applications/{uuid}/storages` to attach a persistent `/data`
 *      volume. Without this the tenant's `restaurant.config.json` (written
 *      in step05) lives only inside the container fs and is wiped on every
 *      restart / redeploy. We verified empirically that Coolify 4.0.0 only
 *      accepts `type=persistent` (or `file`) for directory mounts.
 *   2. PATCH `/applications/{uuid}` to override Coolify's inferred healthcheck.
 *      The `qrsiparis-app` image bakes a HEALTHCHECK on port 3000, but
 *      Coolify rebinds PORT=80 in the container, so the inferred check
 *      fails forever and Coolify marks the app `exited:unhealthy`. We
 *      force the check onto port 80 / `/api/health` here.
 *
 * Both calls are *intentionally* defensive: if either fails the deploy
 * continues, because the app will still be reachable (just without the
 * persistent volume / with a wrong healthcheck). A loud `warn` log line
 * gives ops a breadcrumb to fix up manually.
 *
 * Rollback: best-effort `deleteApp(uuid)`. We swallow errors because
 * the surrounding rollback loop already logs warnings and we want every
 * subsequent rollback to still run. The storage / healthcheck touch-ups
 * have no separate rollback — they're cleaned up implicitly by `deleteApp`.
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

    const projectUuid = process.env['COOLIFY_PROJECT_UUID'];
    const serverUuid = process.env['COOLIFY_SERVER_UUID'];
    if (!projectUuid || !serverUuid) {
      throw new PipelineError(
        ERROR_CODES.API_ERROR,
        'COOLIFY_PROJECT_UUID and COOLIFY_SERVER_UUID env vars are required for Coolify v4 deploys',
      );
    }

    // V1: use `/applications/dockerimage` with nginx:alpine as a
    // proof-of-concept tenant. The dockercompose endpoint in Coolify
    // 4.0.0 returns a UUID but never persists the app (GET/DELETE 404).
    // V1.5 swaps `nginx:alpine` for the real `qrsiparis-app` image.
    const imageRef = process.env['TENANT_APP_IMAGE'] ?? 'nginx:alpine';
    const [imageName, imageTagRaw] = imageRef.includes(':')
      ? imageRef.split(':', 2)
      : [imageRef, 'latest'];
    const imageTag = imageTagRaw || 'latest';

    try {
      const result = await ctx.coolifyClient.createDockerImageApp({
        name: `rest-${ctx.tenant.shortCode}`,
        projectUuid,
        serverUuid,
        environmentName: 'production',
        imageName: imageName!,
        imageTag,
        portsExposes: '80',
        domains: `https://${ctx.tenant.domain}`,
        description: `Tenant ${ctx.tenant.shortCode} — ${ctx.tenant.restaurantName}`,
        instantDeploy: true,
      });
      ctx.coolifyUuid = result.uuid;
      ctx.containerName = ctx.containerName ?? `rest-${ctx.tenant.shortCode}`;
      ctx.log('info', `coolify app created uuid=${result.uuid} domains=${JSON.stringify(result.domains)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new PipelineError(ERROR_CODES.API_ERROR, `Coolify createDockerImageApp failed: ${msg}`);
    }

    // --- defensive post-create touch-ups ---------------------------------
    // (1) Attach a persistent /data volume so step05 can drop the
    //     tenant config there and have it survive container restarts.
    try {
      await ctx.coolifyClient.addPersistentStorage(ctx.coolifyUuid, {
        name: `${ctx.tenant.shortCode}-data`,
        mount_path: '/data',
      });
      ctx.log('info', `coolify storage /data attached uuid=${ctx.coolifyUuid}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log(
        'warn',
        `coolify addPersistentStorage failed (continuing without /data volume): ${msg}`,
      );
    }

    // (2) Override the baked-in HEALTHCHECK. Image declares :3000 but
    //     Coolify rebinds PORT=80, so the inferred check would fail forever.
    try {
      await ctx.coolifyClient.updateAppConfig(ctx.coolifyUuid, {
        health_check_enabled: true,
        health_check_path: '/api/health',
        health_check_port: '80',
        health_check_method: 'GET',
        health_check_return_code: 200,
      });
      ctx.log('info', `coolify healthcheck patched to GET :80/api/health uuid=${ctx.coolifyUuid}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log(
        'warn',
        `coolify updateAppConfig (healthcheck) failed (continuing with inferred check): ${msg}`,
      );
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
