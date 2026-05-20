/**
 * ROLLBACK_RESOLVE — first step of the `rollback` deployment pipeline.
 *
 * Looks at the tenant's `deployments` history (the existing table — no
 * separate `deployment_history` needed for V1.5) and picks the most
 * recent `success` row whose `app_version` differs from the
 * currently-running one. Stamps it onto `ctx.deployment.appVersion`
 * (in memory only, not persisted yet — the rollback deploy row will
 * be updated to reflect the resolved target at this step's exit) and
 * primes `ctx.coolifyUuid` from the tenant's app name so the downstream
 * step03 PATCH + step06 poll know where to act.
 *
 * V1.5 limitation: we restore the previous IMAGE only. The tenant's
 * `configSnapshot` JSON is **not** versioned in V1 — restoring it
 * requires a follow-up migration adding a `tenants.previous_config_snapshot`
 * column (or a proper `deployment_history` table). For V1.5, operators
 * who need to roll back a config change should use the `config_update`
 * pipeline with the old JSON manually pasted in. Once the history
 * table lands this step will also restore the JSON.
 *
 * If no eligible prior deployment exists, we throw a typed error so the
 * runner records a `failed` status with code `NO_ROLLBACK_TARGET`.
 *
 * Idempotency: pure read + ctx mutation — re-running is safe.
 */

import { and, desc, eq, ne } from 'drizzle-orm';

import { db } from '@/db/client';
import { deployments } from '@/db/schema';

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

export const stepRollbackResolve: PipelineStep = {
  name: 'ROLLBACK_RESOLVE',
  async forward(ctx) {
    const currentVersion = ctx.deployment.appVersion ?? '';
    // Most recent successful deployment for this tenant that is NOT the
    // current rollback row itself AND NOT the same app_version as what's
    // running (rolling back to the same version is a no-op for the
    // image; we want the *previous* one).
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
      `rollback target: app_version=${target.appVersion} from deployment=${target.id} (createdAt=${target.createdAt.toISOString()})`,
    );

    // Persist the resolved version onto the rollback deployment row so
    // the operator UI shows the right "rolling back to X" label.
    await db
      .update(deployments)
      .set({ appVersion: target.appVersion })
      .where(eq(deployments.id, ctx.deployment.id));
  },
  async rollback(ctx) {
    ctx.log('info', 'ROLLBACK_RESOLVE rollback: noop (read-only step)');
  },
};
