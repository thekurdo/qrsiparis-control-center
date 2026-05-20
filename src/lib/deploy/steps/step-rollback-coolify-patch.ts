/**
 * ROLLBACK_COOLIFY_PATCH — second step of the `rollback` pipeline.
 *
 * Updates the existing Coolify application's `docker_registry_image_tag`
 * to the version resolved in `step-rollback-resolve`. Coolify won't
 * recreate the container on a PATCH alone; the subsequent
 * `stepRedeployTrigger` is what kicks the actual rolling deploy.
 *
 * Idempotency: PATCH-ing the same tag twice is a noop on Coolify's side.
 * The image-name component (registry/path) is also re-derived so an
 * operator-override `TENANT_APP_IMAGE` env switch is honored on rollback
 * the same way it is on initial deploy.
 */

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

function splitImageRef(ref: string): [string, string] {
  const trimmed = ref.trim();
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon > 0 && !trimmed.slice(lastColon).includes('/')) {
    return [trimmed.slice(0, lastColon), trimmed.slice(lastColon + 1) || 'latest'];
  }
  return [trimmed, 'latest'];
}

function rewriteToGhcr(name: string): string {
  if (name.includes('/')) return name;
  if (name === 'qrsiparis-app') return 'ghcr.io/thekurdo/qrsiparis-app';
  return name;
}

export const stepRollbackCoolifyPatch: PipelineStep = {
  name: 'ROLLBACK_COOLIFY_PATCH',
  async forward(ctx) {
    // Step-rollback-resolve already recovered the coolifyUuid via the
    // shared listApps lookup OR step01 set it from tenants.containerName.
    // If still missing, the redeploy-trigger step will fail loudly — but
    // we'd rather fail HERE so the operator's UI shows the resolve+patch
    // step as failed with a clear code.
    if (!ctx.coolifyUuid) {
      throw new PipelineError(
        ERROR_CODES.API_ERROR,
        'ROLLBACK_COOLIFY_PATCH: ctx.coolifyUuid not set — step-rollback-resolve must run first',
      );
    }
    const target = ctx.deployment.appVersion?.trim();
    if (!target) {
      throw new PipelineError(
        ERROR_CODES.CONFIG_INVALID,
        'ROLLBACK_COOLIFY_PATCH: ctx.deployment.appVersion missing — step-rollback-resolve should have stamped it',
      );
    }

    const [rawName, tag] = splitImageRef(target);
    const imageName = rewriteToGhcr(rawName);

    try {
      await ctx.coolifyClient.updateAppConfig(ctx.coolifyUuid, {
        docker_registry_image_name: imageName,
        docker_registry_image_tag: tag,
      });
      ctx.log(
        'info',
        `coolify image patched to ${imageName}:${tag} on uuid=${ctx.coolifyUuid}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new PipelineError(
        ERROR_CODES.API_ERROR,
        `Coolify image PATCH failed: ${msg}`,
      );
    }
  },
  async rollback(ctx) {
    // Best-effort. A `rollback of a rollback` is V2 — we just log here.
    ctx.log('info', 'ROLLBACK_COOLIFY_PATCH rollback: noop (V1 — no rollback-of-rollback)');
  },
};
