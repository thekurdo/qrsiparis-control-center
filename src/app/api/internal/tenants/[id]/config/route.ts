/**
 * PUT/POST /api/internal/tenants/:id/config — operator-driven config update
 * (Phase H10 / V1.5).
 *
 * Replaces `tenants.config_snapshot` with the operator-edited JSON blob and
 * fans out a `config_update` deployment that:
 *   - bumps `config_version` (step02-config-generate)
 *   - SSH-injects `restaurant.config.json` into the tenant container
 *     (step05-config-inject)
 *   - redeploys + healthchecks
 *
 * Auth: admin only (write surface; matches the wizard POST + lifecycle
 * routes' RBAC posture — config edits can break a customer's live site,
 * so we don't trust the operator role with them).
 *
 * Body: `{ configSnapshot: { restaurant, branding, modules, ... } }`.
 *   - `restaurant`, `branding`, `modules` MUST be present as object keys at
 *     the top level. We do NOT re-validate the inner shape server-side
 *     because the customer-product owns the canonical Zod schema and we
 *     don't want a duplicate source of truth (cross-repo schema package is
 *     V2). The customer-app rejects malformed snapshots at boot, so the
 *     worst case of a bad payload is a failed health-check that we'll
 *     surface in the operator's deploy log.
 *
 * Concurrency: same as `/api/internal/deployments` — if a deployment is
 * already in flight for this tenant, return 409 CONFLICT with the existing
 * deployment id so the UI can redirect to its SSE stream instead of
 * starting a duplicate pipeline.
 *
 * Response: `{ deploymentId, configVersion }` — the new deployment's id
 * (so the UI can navigate to `/deployments/{id}`) and the OLD config
 * version (the bump happens inside step02; the new version is `+1` of
 * what we return here, but we don't know the post-bump number until the
 * worker runs).
 *
 * Audit: writes `tenant.config_updated` with metadata
 *   `{ tenantId, oldVersion, newVersion: oldVersion + 1, deploymentId }`.
 * Mirrors the audit-twice pattern from `/api/internal/tenants` POST
 * (in-tx + out-of-tx) so the IP/UA hashing happens on the request-scoped
 * row while the entity-scoped row gives us atomic guarantees.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { type NextRequest } from 'next/server';
import { z } from 'zod';

import { db } from '@/db/client';
import { auditLog, deployments, tenants } from '@/db/schema';
import {
  errorResponse,
  getClientIp,
  getUserAgent,
  successResponse,
} from '@/lib/api/response';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { recordAudit } from '@/lib/cc/audit';
import { triggerDeployment } from '@/lib/deploy/queue';

/**
 * Top-level shape check. We trust the customer-product to validate the
 * inner branding/modules/limits substructure at boot — duplicating the
 * full schema here would just create a drift surface (the customer-app
 * Zod schema is the source of truth for those nested fields).
 *
 * `.passthrough()` is intentional: operators can extend the snapshot with
 * fields not in this minimal contract (e.g. template-specific config) and
 * we want those passed through verbatim into `config_snapshot` so the
 * tenant boot picks them up.
 */
const bodySchema = z.object({
  configSnapshot: z
    .object({
      restaurant: z.record(z.unknown()),
      branding: z.record(z.unknown()),
      modules: z.record(z.unknown()),
    })
    .passthrough(),
  triggerReason: z.string().max(500).optional(),
});

const DEFAULT_APP_VERSION = process.env['APP_VERSION'] ?? 'dev';

const ACTIVE_DEPLOY_STATUSES = ['pending', 'in_progress'] as const;

/**
 * Sentinel for the inside-tx concurrent-deploy guard. Same pattern as in
 * `/api/internal/deployments` POST.
 */
class ConcurrentDeployError extends Error {
  constructor(public readonly deploymentId: string) {
    super(`Concurrent deployment ${deploymentId} already in flight`);
    this.name = 'ConcurrentDeployError';
  }
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireOperatorAuth(['admin']);
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('VALIDATION_ERROR', 'Geçersiz JSON gövdesi');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const rawFieldErrors = parsed.error.flatten().fieldErrors;
    const fieldErrors: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawFieldErrors)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
        fieldErrors[k] = v[0];
      }
    }
    return errorResponse(
      'VALIDATION_ERROR',
      'Konfigürasyon JSON şeması beklenen üst seviye anahtarları içermiyor (restaurant / branding / modules)',
      { fieldErrors },
    );
  }
  const body = parsed.data;

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, id))
    .limit(1);
  if (!tenant) {
    return errorResponse('NOT_FOUND', 'Müşteri bulunamadı');
  }

  if (tenant.status === 'cancelled') {
    return errorResponse(
      'BUSINESS_RULE_VIOLATION',
      'İptal edilmiş müşteri için konfigürasyon güncellenemez',
      { details: { errorCode: 'TENANT_CANCELLED', status: tenant.status } },
    );
  }
  if (!tenant.serverIdRef) {
    return errorResponse(
      'BUSINESS_RULE_VIOLATION',
      'Müşterinin atanmış sunucusu yok',
    );
  }

  // Pre-tx concurrent-deploy check (cheap). Re-asserted inside the tx
  // below to close the TOCTOU window.
  const existing = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.tenantId, id),
        inArray(deployments.status, [...ACTIVE_DEPLOY_STATUSES]),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return errorResponse(
      'CONFLICT',
      'Bu müşteri için zaten devam eden bir dağıtım var',
      { details: { deploymentId: existing[0]!.id } },
    );
  }

  const oldVersion = tenant.configVersion;
  // We tell the caller what the NEW version will be — step02 bumps to
  // `oldVersion + 1` atomically. The deployments row gets `configVersion:
  // oldVersion` because the bump hasn't happened yet at insert time;
  // step02 updates the in-memory ctx version and the tenant row.
  const newVersion = oldVersion + 1;

  let inserted: { id: string };
  try {
    inserted = await db.transaction(async (tx) => {
      // TOCTOU re-check.
      const concurrent = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.tenantId, id),
            inArray(deployments.status, [...ACTIVE_DEPLOY_STATUSES]),
          ),
        )
        .limit(1);
      if (concurrent.length > 0) {
        throw new ConcurrentDeployError(concurrent[0]!.id);
      }

      // Persist the new config snapshot. config_version is NOT bumped
      // here — step02-config-generate owns that bump so the value is
      // monotonic relative to deployment runs (a row whose snapshot was
      // updated but whose deployment failed before step02 ran would
      // otherwise leak an unused version number).
      await tx
        .update(tenants)
        .set({
          configSnapshot: body.configSnapshot as never,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, id));

      // Pick the latest successful deployment's appVersion so we keep
      // the tenant on the same image — config-only updates must NOT
      // accidentally upgrade the customer-app image (that's what
      // app_update is for).
      const lastSuccessful = await tx
        .select({ appVersion: deployments.appVersion })
        .from(deployments)
        .where(
          and(eq(deployments.tenantId, id), eq(deployments.status, 'success')),
        )
        .orderBy(deployments.createdAt)
        .limit(1);
      const appVersion =
        lastSuccessful[0]?.appVersion ?? DEFAULT_APP_VERSION;

      const rows = await tx
        .insert(deployments)
        .values({
          tenantId: id,
          serverId: tenant.serverIdRef!,
          deploymentType: 'config_update',
          status: 'pending',
          appVersion,
          configVersion: oldVersion,
          triggeredByUserId: session.user.id,
          triggerReason: body.triggerReason ?? 'Config edit (panel)',
        })
        .returning({ id: deployments.id });
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');

      await tx.insert(auditLog).values({
        userId: session.user.id,
        action: 'tenant.config_updated',
        entityType: 'tenant',
        entityId: id,
        metadata: {
          tenantId: id,
          oldVersion,
          newVersion,
          deploymentId: row.id,
        },
        ipAddress: null,
        userAgent: null,
      });

      return row;
    });
  } catch (err) {
    if (err instanceof ConcurrentDeployError) {
      return errorResponse(
        'CONFLICT',
        'Bu müşteri için zaten devam eden bir dağıtım var',
        { details: { deploymentId: err.deploymentId } },
      );
    }
    // eslint-disable-next-line no-console
    console.error('[tenants/config][PUT] update failed', err);
    return errorResponse(
      'INTERNAL_ERROR',
      'Konfigürasyon güncellenemedi',
    );
  }

  // Enqueue after the tx commits (the worker reads the deployments row,
  // so it MUST be visible).
  try {
    await triggerDeployment(inserted.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[tenants/config][PUT] enqueue failed', err);
    await db
      .update(deployments)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorCode: 'ENQUEUE_FAILED',
        errorMessage: err instanceof Error ? err.message : 'unknown',
      })
      .where(eq(deployments.id, inserted.id));
    return errorResponse('INTERNAL_ERROR', 'Kuyruğa alınamadı');
  }

  await recordAudit({
    userId: session.user.id,
    action: 'tenant.config_updated',
    entityType: 'tenant',
    entityId: id,
    metadata: {
      tenantId: id,
      oldVersion,
      newVersion,
      deploymentId: inserted.id,
    },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
  });

  return successResponse(
    { deploymentId: inserted.id, configVersion: newVersion },
    { status: 201 },
  );
}

export const PUT = handler;
export const POST = handler;
