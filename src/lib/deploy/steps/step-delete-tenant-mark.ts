/**
 * DELETE_TENANT_MARK — last step of the `delete` pipeline.
 *
 * Marks the tenant row as `status='cancelled'`. We DO NOT delete the
 * row — keeping it preserves the audit trail (deployment history,
 * backup filenames, audit_log entries all reference the tenantId).
 *
 * Also clears `container_name` + `container_status` since they no
 * longer point to anything real.
 *
 * Idempotency: setting status='cancelled' twice is a noop.
 */

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { tenants } from '@/db/schema';
import { recordAudit } from '@/lib/cc/audit';

import { type PipelineStep } from '../pipeline';

export const stepDeleteTenantMark: PipelineStep = {
  name: 'DELETE_TENANT_MARK',
  async forward(ctx) {
    await db
      .update(tenants)
      .set({
        status: 'cancelled',
        containerStatus: 'not_deployed',
        containerName: null,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, ctx.tenant.id));

    await recordAudit({
      userId: ctx.deployment.triggeredByUserId ?? null,
      action: 'tenant.deleted',
      entityType: 'tenant',
      entityId: ctx.tenant.id,
      metadata: {
        tenantId: ctx.tenant.id,
        shortCode: ctx.tenant.shortCode,
        deploymentId: ctx.deployment.id,
      },
    });

    ctx.log(
      'info',
      `DELETE_TENANT_MARK: tenant=${ctx.tenant.shortCode} status='cancelled' (row preserved for audit)`,
    );
  },
  async rollback(ctx) {
    // We could un-cancel the tenant here, but if DELETE_COOLIFY_APP
    // succeeded the container is already gone — flipping the DB row
    // back to active wouldn't bring the app back. Leaving as-is.
    ctx.log(
      'warn',
      'DELETE_TENANT_MARK rollback: status stays cancelled (Coolify app is already torn down)',
    );
  },
};
