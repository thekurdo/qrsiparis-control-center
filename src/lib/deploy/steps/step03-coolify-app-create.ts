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
 * Post-create touch-ups (all defensive — log+continue on failure):
 *   0. POST `/applications/{uuid}/envs` once per tenant env var. Bakes
 *      AUTH_SECRET + MASTER_KEY (freshly generated per tenant), the
 *      TENANT_* trio (short code / domain / restaurant name),
 *      QRSIPARIS_AUTO_SEED=1 (asks the customer-app pre-start.sh to
 *      auto-migrate + seed demo data on first boot) and a pinned
 *      DATABASE_URL=/data/db.sqlite so the SQLite client doesn't fall
 *      back to a build-time placeholder. We run this BEFORE storage +
 *      healthcheck so the env is already attached when Coolify
 *      provisions the first container — saves one extra recreate.
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
 * All three are *intentionally* defensive: if any fails the deploy
 * continues, because the app will still be reachable (just without env
 * / persistent volume / with a wrong healthcheck). A loud `warn` log
 * line gives ops a breadcrumb to fix up manually.
 *
 * Rollback: best-effort `deleteApp(uuid)`. We swallow errors because
 * the surrounding rollback loop already logs warnings and we want every
 * subsequent rollback to still run. The storage / healthcheck touch-ups
 * have no separate rollback — they're cleaned up implicitly by `deleteApp`.
 *
 * Idempotency: if `ctx.coolifyUuid` is already set (retried pipeline),
 * skip the create call and reuse it.
 */

import { randomBytes } from 'node:crypto';

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

/**
 * Resolve the image name + tag for this tenant's Coolify app.
 *
 * Priority order:
 *   1. `ctx.deployment.appVersion` — the canonical per-deployment version
 *      stamped onto the deployments row. Values look like:
 *        - `qrsiparis-app:v0.1.1` (local-style short name → rewrite to ghcr)
 *        - `ghcr.io/thekurdo/qrsiparis-app:v0.1.1` (explicit registry → as-is)
 *   2. `TENANT_APP_IMAGE` env var on the worker — operator override.
 *   3. `nginx:alpine` — last-resort placeholder so step03 still creates
 *      something Traefik can route during smoke tests.
 *
 * Returns `[imageName, imageTag]` ready to hand to Coolify's
 * `docker_registry_image_name` + `docker_registry_image_tag` fields.
 */
function resolveImageRef(deploymentAppVersion: string | null | undefined): [string, string] {
  const candidate = deploymentAppVersion?.trim()
    ? deploymentAppVersion.trim()
    : (process.env['TENANT_APP_IMAGE'] ?? 'nginx:alpine');

  // Split on the LAST `:` so registry hosts like `ghcr.io:443/...` still parse,
  // but only when that `:` precedes a tag (no `/` after it).
  const lastColon = candidate.lastIndexOf(':');
  let rawName = candidate;
  let rawTag = 'latest';
  if (lastColon > 0 && !candidate.slice(lastColon).includes('/')) {
    rawName = candidate.slice(0, lastColon);
    rawTag = candidate.slice(lastColon + 1) || 'latest';
  }

  // Rewrite the local short name `qrsiparis-app` to the full ghcr path so
  // Coolify can actually pull it. An explicit `ghcr.io/...` (or any path
  // containing `/`) passes through untouched.
  const imageName = rawName.includes('/')
    ? rawName
    : rawName === 'qrsiparis-app'
      ? 'ghcr.io/thekurdo/qrsiparis-app'
      : rawName;

  return [imageName, rawTag];
}

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

    // Image resolution prefers the per-deployment `appVersion` column
    // (e.g. `qrsiparis-app:v0.1.1`) and falls back through the operator
    // override env to a placeholder. See `resolveImageRef` above.
    const [imageName, imageTag] = resolveImageRef(ctx.deployment.appVersion);
    ctx.log('info', `coolify image resolved: ${imageName}:${imageTag}`);

    try {
      const result = await ctx.coolifyClient.createDockerImageApp({
        name: `rest-${ctx.tenant.shortCode}`,
        projectUuid,
        serverUuid,
        environmentName: 'production',
        imageName,
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
    // (0) Inject tenant env vars BEFORE storage attaches, so the first
    //     container Coolify boots already has the full env (saves one
    //     extra recreate). The endpoint takes ONE env per POST, so we
    //     loop. Individual failures are warn+continue — env vars aren't
    //     load-bearing for the container to *start*, only to *work*, so
    //     we never throw from this loop.
    const envs: Array<[string, string]> = [
      ['AUTH_SECRET', randomBytes(32).toString('hex')],
      ['MASTER_KEY', randomBytes(32).toString('hex')],
      ['TENANT_SHORT_CODE', ctx.tenant.shortCode],
      ['TENANT_DOMAIN', ctx.tenant.domain],
      ['TENANT_RESTAURANT_NAME', ctx.tenant.restaurantName],
      ['QRSIPARIS_AUTO_SEED', '1'],
      ['DATABASE_URL', '/data/db.sqlite'],
    ];
    let envOk = 0;
    for (const [key, value] of envs) {
      try {
        await ctx.coolifyClient.addEnv(ctx.coolifyUuid, { key, value });
        envOk++;
      } catch (e) {
        ctx.log(
          'warn',
          `coolify env set ${key} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    ctx.log('info', `coolify envs set: ${envOk}/${envs.length}`);

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
