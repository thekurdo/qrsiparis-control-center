/**
 * POST /api/internal/tenants/:id/cancel  (Scenario S13)
 *
 * Cancels a tenant (soft-delete — the row stays for audit / billing).
 * Side effects:
 *   - Coolify `deleteApp(appId)` — soft-failure (warning logged into
 *     audit metadata, DB still flips to cancelled). The container may
 *     end up orphaned in Coolify; that's preferable to a stuck row
 *     marked active in DB. Ops can clean orphans manually.
 *   - UPDATE tenants SET status='cancelled', container_status='stopped'.
 *     Note: the row is NOT DELETEd — `cancelled` is a state, not a
 *     destruction. This is enforced by the schema's `tenants.status`
 *     enum which lists 'cancelled' as a terminal-but-present value.
 *   - INSERT audit_log `tenant.cancelled` row with full metadata blob.
 *
 * The cron sweepers (S15 contract-expiry, S16 schema-drift, S19 backup)
 * all filter on status='active' so cancelled tenants automatically stop
 * receiving cron-driven side effects. The S19 docstring (downstream note
 * to S13) confirms this is intentional.
 *
 * Auth: admin only. The 2-step confirmation lives in the UI — the API
 * itself only enforces RBAC + source-state.
 *
 * Source state: tenant.status must be 'onboarding', 'active', or
 * 'paused'. Re-cancelling a cancelled tenant is rejected with 422 so
 * the UI can surface "already cancelled".
 *
 * --- BLOCKING NEW DEPLOYMENTS ---
 * Once status='cancelled', POST /api/internal/deployments returns
 * 422 BUSINESS_RULE_VIOLATION with `errorCode: 'TENANT_CANCELLED'` in
 * the details. That guard lives in the deployments route itself (the
 * worker's step01 PRECHECK has the same check, but we want to fail
 * fast at the HTTP layer so the operator UI doesn't render a spinning
 * pipeline that will immediately rollback).
 */

import type { NextRequest } from 'next/server';

import { requireOperatorAuth } from '@/lib/auth/middleware';
import { runLifecycleAction } from '@/lib/cc/tenant-lifecycle';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireOperatorAuth(['admin']);
  const { id } = await params;
  return runLifecycleAction({
    action: 'cancel',
    tenantId: id,
    actorUserId: session.user.id,
    req,
  });
}
