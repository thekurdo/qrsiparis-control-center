/**
 * POST /api/internal/deployments — trigger a new deployment (Phase H6).
 *
 * Auth: any authenticated operator. The wizard "ilk kurulum" flow + the
 * tenant detail "yeniden dağıt" button both hit this endpoint.
 *
 * Body:
 *   - tenantId        (uuid, required)
 *   - deploymentType  ('initial' | 'config_update' | 'app_update' | 'redeploy' | 'rollback')
 *   - appVersion      (optional — defaults to env APP_VERSION at the worker)
 *   - triggerReason   (optional free-text)
 *
 * Side effects:
 *   1. INSERT deployments row (status='pending').
 *   2. INSERT audit_log `deployment.triggered`.
 *   3. Enqueue BullMQ job — the worker picks it up and drives the pipeline.
 *
 * Response: { deploymentId } so the UI can subscribe to the SSE log
 * stream (`GET /api/internal/deployments/{id}/log`, Phase H8).
 *
 * Error surface:
 *   - NOT_FOUND     — tenant id doesn't exist
 *   - BUSINESS_RULE — tenant has no server assigned
 *   - VALIDATION    — body shape wrong
 */

import { eq } from 'drizzle-orm';
import { type NextRequest } from 'next/server';
import { z } from 'zod';

import { db } from '@/db/client';
import { auditLog, deployments, tenants } from '@/db/schema';
import { errorResponse, getClientIp, getUserAgent, successResponse } from '@/lib/api/response';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { recordAudit } from '@/lib/cc/audit';
import { triggerDeployment } from '@/lib/deploy/queue';

const schema = z.object({
  tenantId: z.string().uuid(),
  deploymentType: z.enum([
    'initial',
    'config_update',
    'app_update',
    'redeploy',
    'rollback',
  ]),
  appVersion: z.string().min(1).optional(),
  triggerReason: z.string().max(500).optional(),
});

const DEFAULT_APP_VERSION = process.env['APP_VERSION'] ?? 'dev';

export async function POST(req: NextRequest) {
  const session = await requireOperatorAuth();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('VALIDATION_ERROR', 'Geçersiz JSON gövdesi');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const rawFieldErrors = parsed.error.flatten().fieldErrors;
    const fieldErrors: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawFieldErrors)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
        fieldErrors[k] = v[0];
      }
    }
    return errorResponse('VALIDATION_ERROR', 'Form alanlarını kontrol edin', {
      fieldErrors,
    });
  }
  const body = parsed.data;

  const tenant = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, body.tenantId))
    .limit(1)
    .then((r) => r[0]);
  if (!tenant) {
    return errorResponse('NOT_FOUND', 'Müşteri bulunamadı');
  }
  if (!tenant.serverIdRef) {
    return errorResponse(
      'BUSINESS_RULE_VIOLATION',
      'Müşterinin atanmış sunucusu yok',
    );
  }

  let inserted: { id: string };
  try {
    inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(deployments)
        .values({
          tenantId: body.tenantId,
          serverId: tenant.serverIdRef!,
          deploymentType: body.deploymentType,
          status: 'pending',
          appVersion: body.appVersion ?? DEFAULT_APP_VERSION,
          configVersion: tenant.configVersion,
          triggeredByUserId: session.user.id,
          triggerReason: body.triggerReason ?? null,
        })
        .returning({ id: deployments.id });

      const row = rows[0];
      if (!row) throw new Error('insert returned no row');

      await tx.insert(auditLog).values({
        userId: session.user.id,
        action: 'deployment.triggered',
        entityType: 'deployment',
        entityId: row.id,
        metadata: {
          deploymentType: body.deploymentType,
          tenantId: body.tenantId,
          appVersion: body.appVersion ?? DEFAULT_APP_VERSION,
        },
        ipAddress: null,
        userAgent: null,
      });

      return row;
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[deployments][POST] insert failed', err);
    return errorResponse('INTERNAL_ERROR', 'Dağıtım kaydı oluşturulamadı');
  }

  // Enqueue AFTER the DB transaction commits — the worker reads the row,
  // so we MUST NOT enqueue inside the tx (race window where the worker
  // wakes up before commit and 404s).
  try {
    await triggerDeployment(inserted.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[deployments][POST] enqueue failed', err);
    // Mark the row failed immediately so the operator UI doesn't show it
    // stuck in 'pending' forever waiting for a worker that'll never run.
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

  // Out-of-tx audit captures the request identifiers (KVKK-hashed).
  await recordAudit({
    userId: session.user.id,
    action: 'deployment.triggered',
    entityType: 'deployment',
    entityId: inserted.id,
    metadata: {
      deploymentType: body.deploymentType,
      tenantId: body.tenantId,
    },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
  });

  return successResponse({ deploymentId: inserted.id }, { status: 201 });
}
