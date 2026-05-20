/**
 * DELETE_COOLIFY_APP — second step of the `delete` pipeline.
 *
 * Calls Coolify's DELETE /api/v1/applications/{uuid} to stop the
 * tenant's container, remove its Traefik labels (SSL + routing
 * disappear), and drop the persistent /data volume.
 *
 * coolifyUuid is recovered via `listApps()` lookup (same trick as
 * step-redeploy-trigger) — operators may invoke delete from an
 * operator UI that hasn't preloaded the UUID.
 *
 * Failure semantics: if the Coolify delete API returns 404 we treat
 * that as success (the app is already gone — exactly the state we
 * want). Other errors propagate as PipelineError.
 */

import { CoolifyApiError } from '@/types/coolify';

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

export const stepDeleteCoolifyApp: PipelineStep = {
  name: 'DELETE_COOLIFY_APP',
  async forward(ctx) {
    // Find coolifyUuid if not already on ctx.
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
        ctx.log('warn', `listApps failed: ${msg}`);
      }
    }

    if (!ctx.coolifyUuid) {
      ctx.log(
        'info',
        `DELETE_COOLIFY_APP: no Coolify app found for ${ctx.tenant.shortCode} — already removed?`,
      );
      return;
    }

    try {
      await ctx.coolifyClient.deleteApp(ctx.coolifyUuid);
      ctx.log('info', `coolify app deleted uuid=${ctx.coolifyUuid}`);
    } catch (e) {
      // 404 = already gone, that's the goal.
      if (e instanceof CoolifyApiError && e.statusCode === 404) {
        ctx.log(
          'info',
          `coolify app already gone uuid=${ctx.coolifyUuid} (404 → treated as success)`,
        );
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new PipelineError(
        ERROR_CODES.API_ERROR,
        `Coolify deleteApp failed: ${msg}`,
      );
    }
  },
  async rollback(ctx) {
    // No undoing a delete. Forward step is idempotent on retries; the
    // surrounding pipeline rollback only triggers if a LATER step fails,
    // and bringing the container back from a successful Coolify delete
    // would require a full re-deploy from scratch — out of scope for V1.5.
    ctx.log(
      'warn',
      'DELETE_COOLIFY_APP rollback: cannot undo a successful Coolify delete (V1.5 limitation)',
    );
  },
};
