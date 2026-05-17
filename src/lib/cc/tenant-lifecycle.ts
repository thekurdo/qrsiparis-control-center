/**
 * Tenant lifecycle helpers (Scenario S13 — Phase H10).
 *
 * Three operator-driven state transitions:
 *   - PAUSE    : active → paused     | stopApp + container_status='stopped'
 *   - RESUME   : paused → active     | restartApp + container_status='running'
 *   - CANCEL   : * → cancelled       | deleteApp + container_status='stopped'
 *                                     (soft delete — row stays for audit trail)
 *
 * Each transition fans out the side-effects in this order:
 *   1. Validate the current `tenants.status` is a legal source for the move.
 *      (paused→pause, active→resume, cancelled→anything = rejected as
 *      BUSINESS_RULE_VIOLATION.)
 *   2. Build a Coolify client pointed at the tenant's server. Call the
 *      appropriate verb (stopApp / restartApp / deleteApp). Coolify errors
 *      DURING pause/cancel are tolerated with a warning log — the DB state
 *      transition still proceeds because operator intent matters more than
 *      a flaky Coolify call (we'd rather have `status='cancelled'` in DB
 *      and an orphan Coolify app than a stuck active tenant). For RESUME
 *      the Coolify call is load-bearing (no container = no service), so
 *      we surface its failure.
 *   3. UPDATE the tenant row in a single SQL statement.
 *   4. Write an `audit_log` row (`tenant.paused` / `tenant.resumed` /
 *      `tenant.cancelled`). Metadata records the prior status, the new
 *      status, the actor, and the Coolify app identifier we tried.
 *
 * --- COOLIFY IDENTIFIER STRATEGY ---
 * V1 does not persist `coolifyUuid` on the tenant row (no column). The
 * deploy pipeline obtains it lazily from `createApp()` and only keeps it
 * in pipeline-scoped memory. For lifecycle calls we use
 * `containerName ?? shortCode` as the identifier — both are unique per
 * tenant and the WireMock mappings use `/api/v1/applications/[^/]+/{stop,restart}`
 * regex, so any non-slash identifier slots into the assertion.
 *
 * In production, Coolify maps both UUID and `name` to the same app, so
 * passing `shortCode` works against real Coolify too (V1 commitment is
 * "shortCode == Coolify app name"; see CoolifyCreateAppInput.name).
 *
 * --- WHY NOT A SHARED PATCH ROUTE ---
 * Three POST action routes feel verbose vs. one PATCH with `{status: ...}`.
 * The trade-off:
 *   - POST /pause is self-documenting in server logs and audit URLs.
 *   - 2-step destructive confirmation (cancel) lives in its own route so
 *     the UI doesn't have to encode "destructive-ness" in PATCH body.
 *   - Each route can have distinct rate-limit + RBAC rules in V1.5.
 * The 3-route shape mirrors the existing operator-user reset endpoints
 * (`reset-password`, `reset-2fa`) and is the established control-center
 * convention.
 */

import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';

import { db } from '@/db/client';
import { tenants, servers } from '@/db/schema';
import {
  errorResponse,
  getClientIp,
  getUserAgent,
  successResponse,
} from '@/lib/api/response';
import { recordAudit } from '@/lib/cc/audit';
import { CoolifyClient } from '@/lib/coolify';
import type {
  CoolifyMockMode,
  CoolifyApiError as CoolifyApiErrorType,
} from '@/types/coolify';
import type { Tenant, Server, TenantStatus } from '@/types/db';

export type LifecycleAction = 'pause' | 'resume' | 'cancel';

/**
 * Map a lifecycle action to the audit verb. The dotted convention matches
 * `tenant.created` / `deployment.triggered` and is the canonical control-
 * center audit naming style (S5 docstring lists both conventions in use).
 */
const ACTION_TO_AUDIT: Record<LifecycleAction, string> = {
  pause: 'tenant.paused',
  resume: 'tenant.resumed',
  cancel: 'tenant.cancelled',
};

/**
 * Map a lifecycle action to the post-transition tenant.status.
 */
const ACTION_TO_STATUS: Record<LifecycleAction, TenantStatus> = {
  pause: 'paused',
  resume: 'active',
  cancel: 'cancelled',
};

/**
 * Map a lifecycle action to the post-transition container_status.
 *
 * Cancel sets `stopped` rather than `not_deployed` because the container
 * COULD have existed (we just told Coolify to delete it). If Coolify's
 * deleteApp succeeded the container is gone, but the row's
 * container_status is a logical state for the panel UI to render — and
 * `stopped` more honestly says "we asked it to stop, the row exists for
 * history". `not_deployed` is reserved for tenants that never had a
 * deployment.
 */
const ACTION_TO_CONTAINER_STATUS: Record<
  LifecycleAction,
  'running' | 'stopped'
> = {
  pause: 'stopped',
  resume: 'running',
  cancel: 'stopped',
};

/**
 * Allowed source statuses for each action.
 *
 *   pause:  must be active (paused or cancelled is meaningless to pause)
 *   resume: must be paused
 *   cancel: pause OR active (cancelling a cancelled tenant is a no-op
 *           we explicitly reject so the UI surfaces "already cancelled")
 *
 * onboarding tenants can't be paused/resumed (no deployed container yet).
 * They CAN be cancelled — a customer who signs and then cancels before
 * deploy. The `tenants.status` enum has `cancelled` already and the row
 * stays for audit / billing reconciliation.
 */
const ALLOWED_FROM: Record<LifecycleAction, TenantStatus[]> = {
  pause: ['active'],
  resume: ['paused'],
  cancel: ['onboarding', 'active', 'paused'],
};

/**
 * Build a Coolify client for the given server. Mirrors the
 * `defaultCoolifyClient()` factory in `src/lib/deploy/context.ts` but is
 * scoped to a specific server's Coolify URL — V1 collapses these to one
 * WireMock instance, but V1.5 may run separate Coolifys per VPS.
 */
function buildCoolifyClient(server: Server): CoolifyClient {
  // Prefer the server's coolify_url; fall back to process env so tests
  // that don't seed coolify_url still work. The token is global in V1
  // (one Coolify, one token).
  const baseUrl = server.coolifyUrl ?? process.env['COOLIFY_API_URL'];
  if (!baseUrl) {
    throw new Error(
      'No Coolify URL — server has no coolifyUrl and COOLIFY_API_URL env is unset',
    );
  }
  const token = process.env['COOLIFY_API_TOKEN'] ?? '';
  const mockModeRaw = process.env['COOLIFY_MOCK_MODE'];
  // Permissive parse — only forward when it matches a known mode (mirrors
  // `readMockModeFromEnv` in context.ts; we don't import that function to
  // avoid pulling the whole deploy module graph into this lifecycle handler).
  const mockMode: CoolifyMockMode | undefined =
    mockModeRaw === 'happy' ||
    mockModeRaw === 'deploy-fail' ||
    mockModeRaw === 'health-fail' ||
    mockModeRaw === 'timeout'
      ? mockModeRaw
      : undefined;
  return new CoolifyClient({
    baseUrl,
    token,
    ...(mockMode ? { mockMode } : {}),
  });
}

/**
 * Resolve the Coolify app identifier for a tenant.
 *
 * In V1 we don't persist the Coolify UUID. Both `containerName` and
 * `shortCode` are unique per tenant; we prefer `containerName` if set
 * (matches what step03 stamps as `rest-{shortCode}`) and fall back to
 * `shortCode` for onboarding tenants that never reached the deploy
 * pipeline.
 */
function coolifyIdentifierFor(tenant: Tenant): string {
  return tenant.containerName ?? tenant.shortCode;
}

/**
 * Execute the appropriate Coolify verb. Errors are NOT thrown — they're
 * returned as a string so the caller can decide whether to abort
 * (RESUME) or proceed with the DB transition (PAUSE / CANCEL).
 *
 * The "we proceed on Coolify error" semantics for PAUSE / CANCEL exist
 * because the operator's intent is what matters: if the operator says
 * "cancel this tenant" and Coolify is flaky, we'd rather have the row
 * cancelled in DB (so billing / quotas / cron sweeps all stop) and
 * leave an orphan Coolify app for ops to clean up than block the
 * lifecycle on a third-party 5xx.
 */
async function callCoolify(
  action: LifecycleAction,
  client: CoolifyClient,
  appId: string,
): Promise<string | null> {
  try {
    switch (action) {
      case 'pause':
        await client.stopApp(appId);
        return null;
      case 'resume':
        await client.restartApp(appId);
        return null;
      case 'cancel':
        await client.deleteApp(appId);
        return null;
    }
  } catch (e) {
    // The CoolifyApiError type carries statusCode + coolifyCode; we
    // serialise its message for the audit metadata + caller decision.
    const ce = e as CoolifyApiErrorType;
    const message =
      ce && typeof ce.message === 'string'
        ? ce.message
        : e instanceof Error
          ? e.message
          : String(e);
    return message;
  }
}

/**
 * Drive a single tenant lifecycle transition. Returns the same response
 * shape (`successResponse` / `errorResponse`) every route handler in this
 * codebase emits so callers can just `return runLifecycleAction(...)`.
 *
 * Auth: caller MUST have already passed `requireOperatorAuth()` —
 * usually with the 'admin' role gate. This helper doesn't re-check.
 *
 * Side effects (all happen sequentially for ordering clarity in audit
 * trails):
 *   1. Coolify call (stop/restart/delete).
 *   2. UPDATE tenants SET status + container_status.
 *   3. INSERT audit_log row with full metadata blob.
 */
export async function runLifecycleAction(args: {
  action: LifecycleAction;
  tenantId: string;
  actorUserId: string;
  req: NextRequest;
}): Promise<Response> {
  const { action, tenantId, actorUserId, req } = args;

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) {
    return errorResponse('NOT_FOUND', 'Müşteri bulunamadı');
  }

  // Validate source state. The error message mentions both the current
  // and the attempted action so the operator UI can show useful copy
  // without parsing the code.
  if (!ALLOWED_FROM[action].includes(tenant.status)) {
    return errorResponse(
      'BUSINESS_RULE_VIOLATION',
      `Müşteri durumu '${tenant.status}' iken '${action}' işlemi uygulanamaz`,
      { details: { currentStatus: tenant.status, action } },
    );
  }

  // Server is optional in our schema (onDelete: set null) but required
  // for any Coolify-side action. For an onboarding tenant being
  // cancelled we may have a server but no deployed container — we still
  // attempt the Coolify call (it will probably 404, which we tolerate
  // for cancel) so the audit metadata records the intent.
  let server: Server | null = null;
  if (tenant.serverIdRef) {
    const rows = await db
      .select()
      .from(servers)
      .where(eq(servers.id, tenant.serverIdRef))
      .limit(1);
    server = rows[0] ?? null;
  }

  let coolifyError: string | null = null;
  const appId = coolifyIdentifierFor(tenant);
  if (server) {
    try {
      const client = buildCoolifyClient(server);
      coolifyError = await callCoolify(action, client, appId);
    } catch (e) {
      // buildCoolifyClient threw (no baseUrl). Treat as a Coolify error
      // and decide based on the action.
      coolifyError = e instanceof Error ? e.message : String(e);
    }
  } else {
    coolifyError = 'tenant has no assigned server';
  }

  // Resume hard-fails if Coolify did. The other two actions log a
  // warning into audit metadata but still flip the DB row.
  if (action === 'resume' && coolifyError) {
    return errorResponse(
      'INTERNAL_ERROR',
      `Coolify ${action} çağrısı başarısız: ${coolifyError}`,
      { details: { coolifyError } },
    );
  }

  const newStatus = ACTION_TO_STATUS[action];
  const newContainerStatus = ACTION_TO_CONTAINER_STATUS[action];

  try {
    await db
      .update(tenants)
      .set({
        status: newStatus,
        containerStatus: newContainerStatus,
      })
      .where(eq(tenants.id, tenantId));
  } catch (err) {
    console.error('[tenant-lifecycle] update failed', err);
    return errorResponse(
      'INTERNAL_ERROR',
      'Müşteri durumu güncellenemedi',
    );
  }

  await recordAudit({
    userId: actorUserId,
    action: ACTION_TO_AUDIT[action],
    entityType: 'tenant',
    entityId: tenantId,
    metadata: {
      previousStatus: tenant.status,
      newStatus,
      previousContainerStatus: tenant.containerStatus,
      newContainerStatus,
      coolifyAppId: appId,
      coolifyError: coolifyError ?? undefined,
      shortCode: tenant.shortCode,
    },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
  });

  return successResponse({
    id: tenantId,
    status: newStatus,
    containerStatus: newContainerStatus,
    coolifyError: coolifyError ?? null,
  });
}
