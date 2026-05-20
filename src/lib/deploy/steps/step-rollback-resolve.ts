/**
 * ROLLBACK_RESOLVE — first step of the `rollback` deployment pipeline.
 *
 * Prefers a `deployment_history` snapshot (full image + config restore).
 * Falls back to the legacy "scan deployments table" strategy when no
 * history rows exist yet (e.g. tenants created before the history table
 * landed). The legacy path restores image only.
 *
 * Updates `ctx.deployment.appVersion` (and persists it onto the
 * rollback deployment row for UI display). Optionally writes a fresh
 * `tenants.config_snapshot` if the history row carried one. Marks the
 * picked history row as `status='rolled_back'` so a chain of rollbacks
 * doesn't keep landing on the same target.
 *
 * Throws `NO_ROLLBACK_TARGET` if nothing eligible found anywhere.
 */

import { and, desc, eq, isNull, ne } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  deployments,
  deploymentHistory,
  tenants,
} from '@/db/schema';

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

export const stepRollbackResolve: PipelineStep = {
  name: 'ROLLBACK_RESOLVE',
  async forward(ctx) {
    const currentVersion = ctx.deployment.appVersion ?? '';

    // ---- Path A: prefer deployment_history (full restore) -----------------
    const history = await db
      .select({
        id: deploymentHistory.id,
        appVersion: deploymentHistory.appVersion,
        configSnapshot: deploymentHistory.configSnapshot,
        configVersion: deploymentHistory.configVersion,
        createdAt: deploymentHistory.createdAt,
      })
      .from(deploymentHistory)
      .where(
        and(
          eq(deploymentHistory.tenantId, ctx.tenant.id),
          eq(deploymentHistory.status, 'success'),
          isNull(deploymentHistory.archivedAt),
        ),
      )
      .orderBy(desc(deploymentHistory.createdAt))
      .limit(10);

    const histTarget = history.find(
      (h) => h.appVersion !== currentVersion,
    );
    if (histTarget) {
      ctx.deployment.appVersion = histTarget.appVersion;
      ctx.log(
        'info',
        `rollback target (history): app_version=${histTarget.appVersion} configVersion=${histTarget.configVersion} from history=${histTarget.id}`,
      );

      // Persist resolved image onto rollback deployment row.
      await db
        .update(deployments)
        .set({
          appVersion: histTarget.appVersion,
          configVersion: histTarget.configVersion,
        })
        .where(eq(deployments.id, ctx.deployment.id));

      // Restore the captured config snapshot onto the tenant. Subsequent
      // step05 (CONFIG_INJECT) will pick this up via ctx.tenant.configSnapshot
      // — which we also rewrite here so the in-memory ctx matches the DB.
      await db
        .update(tenants)
        .set({
          configSnapshot: histTarget.configSnapshot,
          configVersion: histTarget.configVersion,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, ctx.tenant.id));
      ctx.tenant.configSnapshot = histTarget.configSnapshot;
      ctx.tenant.configVersion = histTarget.configVersion;

      // Mark history row as rolled-back so a follow-up rollback picks the
      // NEXT one back instead of bouncing between two states.
      await db
        .update(deploymentHistory)
        .set({ status: 'rolled_back', archivedAt: new Date() })
        .where(eq(deploymentHistory.id, histTarget.id));
      return;
    }

    // ---- Path B: legacy fallback (image only) -----------------------------
    // Older tenants (pre-deployment_history) have no snapshots — fall back
    // to scanning the deployments table.
    const rows = await db
      .select({
        id: deployments.id,
        appVersion: deployments.appVersion,
        configVersion: deployments.configVersion,
        createdAt: deployments.createdAt,
      })
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, ctx.tenant.id),
          eq(deployments.status, 'success'),
          ne(deployments.id, ctx.deployment.id),
        ),
      )
      .orderBy(desc(deployments.createdAt))
      .limit(10);

    const target = rows.find(
      (r) => r.appVersion !== currentVersion && r.appVersion != null,
    );
    if (!target) {
      throw new PipelineError(
        ERROR_CODES.CONFIG_INVALID,
        'NO_ROLLBACK_TARGET: no prior successful deployment to roll back to',
      );
    }

    ctx.deployment.appVersion = target.appVersion;
    ctx.log(
      'info',
      `rollback target (legacy/image-only): app_version=${target.appVersion} from deployment=${target.id}`,
    );

    await db
      .update(deployments)
      .set({ appVersion: target.appVersion })
      .where(eq(deployments.id, ctx.deployment.id));
  },
  async rollback(ctx) {
    ctx.log('info', 'ROLLBACK_RESOLVE rollback: noop (read-only step)');
  },
};
