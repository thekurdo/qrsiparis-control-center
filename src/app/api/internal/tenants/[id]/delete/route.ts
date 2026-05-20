/**
 * POST /api/internal/tenants/:id/delete
 *
 * Full tenant teardown via the deploy pipeline (deploymentType='delete'):
 *   1. PRECHECK
 *   2. DELETE_FINAL_BACKUP — last sqlite hot-backup → gzipped on host
 *   3. DELETE_COOLIFY_APP — DELETE /applications/{uuid}
 *   4. DELETE_TENANT_MARK — UPDATE tenants SET status='cancelled'
 *
 * Pipeline-driven, traceable counterpart to the existing
 * `POST /api/internal/tenants/:id/cancel` (lighter-weight immediate cancel).
 * Use `cancel` for emergencies, `delete` for clean end-of-contract teardowns.
 *
 * Auth: admin only.
 * Returns 202 with `{ deploymentId }` so the operator UI can redirect
 * to `/deployments/{id}` and watch the teardown run live.
 */

import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import { requireOperatorAuth } from '@/lib/auth/middleware';
import { db } from '@/db/client';
import { deployments, tenants } from '@/db/schema';
import { triggerDeployment } from '@/lib/deploy/queue';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireOperatorAuth(['admin']);
  const { id } = await params;

  const tenant = (
    await db.select().from(tenants).where(eq(tenants.id, id)).limit(1)
  )[0];
  if (!tenant) {
    return Response.json(
      { success: false, error: { code: 'NOT_FOUND', message: 'tenant not found' } },
      { status: 404 },
    );
  }

  if (tenant.status === 'cancelled') {
    return Response.json(
      {
        success: false,
        error: {
          code: 'BUSINESS_RULE_VIOLATION',
          message: 'tenant already cancelled',
        },
      },
      { status: 422 },
    );
  }
  if (!tenant.serverIdRef) {
    return Response.json(
      {
        success: false,
        error: {
          code: 'BUSINESS_RULE_VIOLATION',
          message: 'tenant has no server assignment — nothing to delete',
        },
      },
      { status: 422 },
    );
  }

  const inserted = await db
    .insert(deployments)
    .values({
      tenantId: tenant.id,
      serverId: tenant.serverIdRef,
      deploymentType: 'delete',
      status: 'pending',
      appVersion: 'delete', // pin for audit; pipeline doesn't use it
      configVersion: tenant.configVersion ?? 1,
      triggerReason: 'operator-initiated tenant delete',
      triggeredByUserId: session.user.id,
    })
    .returning();

  const dep = inserted[0];
  if (!dep) {
    return Response.json(
      { success: false, error: { code: 'INTERNAL', message: 'failed to insert deployment' } },
      { status: 500 },
    );
  }

  await triggerDeployment(dep.id);

  return Response.json(
    {
      success: true,
      data: {
        deploymentId: dep.id,
        tenantId: tenant.id,
        shortCode: tenant.shortCode,
      },
    },
    { status: 202 },
  );
}
