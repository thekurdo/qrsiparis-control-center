/**
 * Step 10 — POST_DEPLOY (Phase H6 — REAL).
 *
 * Marks the tenant `active` + `running`, writes a `deploy.success` audit
 * row. This is the "point of no return" — once we reach this step the
 * pipeline is considered successful even if a later concern (cert renewal,
 * external monitoring) flags issues — those are tracked separately.
 *
 * Idempotency: status updates are no-ops if already `active`/`running`.
 * Audit insert duplicates are tolerated (each pipeline produces one row
 * keyed by deployment.id; retries simply append another success entry,
 * which is fine for forensics).
 */

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { auditLog, tenants } from '@/db/schema';

import type { PipelineStep } from '../pipeline';

export const step10PostDeploy: PipelineStep = {
  name: 'POST_DEPLOY',
  async forward(ctx) {
    ctx.log('info', 'Post-deploy: marking tenant active + deployment success');

    await db.transaction(async (tx) => {
      await tx
        .update(tenants)
        .set({
          status: 'active',
          containerStatus: 'running',
          containerName: ctx.containerName ?? `${ctx.tenant.shortCode}-app`,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, ctx.tenant.id));

      await tx.insert(auditLog).values({
        userId: ctx.deployment.triggeredByUserId ?? null,
        action: 'deploy.success',
        entityType: 'deployment',
        entityId: ctx.deployment.id,
        metadata: {
          tenantId: ctx.tenant.id,
          deploymentType: ctx.deployment.deploymentType,
          durationSeconds: ctx.durationSeconds ?? null,
        },
        ipAddress: null,
        userAgent: null,
      });
    });

    ctx.log('info', 'Tenant marked active');
  },
  async rollback() {
    // No rollback — once we've marked the deployment a success the
    // operator UI is already showing it as live. Subsequent failures
    // (if any later step is added) require a manual operator action.
  },
};
