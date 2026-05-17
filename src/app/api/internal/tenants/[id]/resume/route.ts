/**
 * POST /api/internal/tenants/:id/resume  (Scenario S13)
 *
 * Resumes a `paused` tenant. Side effects:
 *   - Coolify `restartApp(appId)` — HARD-failure (returns 500 to the
 *     caller). Unlike pause/cancel where operator intent dominates and
 *     we'd rather mark the row stopped than leave it active, resume
 *     without a running container is meaningless — we'd be claiming
 *     "active" while the customer site is down.
 *   - UPDATE tenants SET status='active', container_status='running'.
 *   - INSERT audit_log `tenant.resumed` row with full metadata blob.
 *
 * Auth: admin only.
 *
 * Source state: tenant.status must be 'paused'.
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
    action: 'resume',
    tenantId: id,
    actorUserId: session.user.id,
    req,
  });
}
