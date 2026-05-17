/**
 * POST /api/internal/tenants/:id/pause  (Scenario S13)
 *
 * Pauses an `active` tenant. Side effects:
 *   - Coolify `stopApp(appId)` — soft-failure (warning logged into audit
 *     metadata, DB state still transitions). See
 *     `src/lib/cc/tenant-lifecycle.ts` for the rationale.
 *   - UPDATE tenants SET status='paused', container_status='stopped'.
 *   - INSERT audit_log `tenant.paused` row with full metadata blob.
 *
 * Auth: admin only — pause/resume/cancel are destructive ops and we
 * scope them to the admin role per the broader R13 (write surface)
 * convention.
 *
 * Source state: tenant.status must be 'active' (paused→pause and
 * cancelled→pause are 422 BUSINESS_RULE_VIOLATION).
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
    action: 'pause',
    tenantId: id,
    actorUserId: session.user.id,
    req,
  });
}
