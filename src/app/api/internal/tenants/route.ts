/**
 * POST /api/internal/tenants — create a new tenant from the wizard (Phase H6).
 *
 * Auth: admin only (write surface; IMPL §3 R13).
 * Body: the full wizard state (step1..step7). Saved verbatim into
 *       `tenants.config_snapshot` so the deploy pipeline can re-render
 *       the customer-product config from a single source of truth.
 *
 * Side effects:
 *   - INSERT tenants row with status='onboarding', container_status='not_deployed'
 *   - INSERT audit_log `tenant.created`
 *
 * Response: { tenantId } so the wizard can redirect to the tenant detail
 * page or trigger an initial deployment immediately.
 *
 * Why a passthrough Zod schema for the inner steps: the wizard schema
 * lives in client components and we don't want a duplicate source-of-
 * truth here. We validate the fields the DB *needs* and trust the rest
 * for the configSnapshot payload. A future (V1.5) shared schema package
 * can replace `.passthrough()` with strict shapes.
 *
 * GET on this route is intentionally not implemented yet — see
 * `/musteriler` panel page for the list view (server component reads DB
 * directly).
 */

import { type NextRequest } from 'next/server';
import { z } from 'zod';

import { db } from '@/db/client';
import { auditLog, tenants } from '@/db/schema';
import { errorResponse, getClientIp, getUserAgent, successResponse } from '@/lib/api/response';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { recordAudit } from '@/lib/cc/audit';

const wizardSchema = z.object({
  step1: z
    .object({
      restaurantName: z.string().min(1),
      shortCode: z
        .string()
        .min(3)
        .max(50)
        .regex(/^[a-z0-9-]+$/),
      contactName: z.string().min(1),
      phone: z.string().min(1),
      email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
      city: z.string().min(1),
      address: z.string().optional(),
    })
    .passthrough(),
  step2: z
    .object({
      tier: z.enum(['baslangic', 'standart', 'profesyonel']),
      contractStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      durationMonths: z.union([z.literal(6), z.literal(12), z.literal(24)]),
      monthlyFeeKurus: z.number().int().nonnegative().optional(),
      salesPartner: z.enum(['yok', 'proviat']).optional(),
      commissionRatePercent: z.number().int().min(0).max(100).optional(),
    })
    .passthrough(),
  step3: z
    .object({
      domain: z.string().min(1),
    })
    .passthrough(),
  step4: z
    .object({
      template: z.string().min(1),
      primaryColor: z.string().min(1),
    })
    .passthrough(),
  step5: z.object({}).passthrough().optional(),
  step6: z.object({
    serverId: z.string().uuid(),
  }),
  step7: z.object({}).passthrough().optional(),
});

type WizardPayload = z.infer<typeof wizardSchema>;

/**
 * Compute contract end-date from start + duration. Hour/min/sec are
 * irrelevant (timestamp column with no time-of-day expectations).
 */
function computeContractEnd(startDateIso: string, durationMonths: number): Date {
  const start = new Date(`${startDateIso}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + durationMonths);
  return end;
}

export async function POST(req: NextRequest) {
  const session = await requireOperatorAuth(['admin']);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('VALIDATION_ERROR', 'Geçersiz JSON gövdesi');
  }

  const parsed = wizardSchema.safeParse(raw);
  if (!parsed.success) {
    // Zod flatten gives string[] per field; collapse to one string for our
    // envelope (operators only need to see the first complaint per field).
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

  const data: WizardPayload = parsed.data;

  const contractStart = new Date(`${data.step2.contractStartDate}T00:00:00Z`);
  const contractEnd = computeContractEnd(
    data.step2.contractStartDate,
    data.step2.durationMonths,
  );
  const signedAt = new Date();

  // sales_partner: wizard 'yok' → NULL (direkt satış).
  const salesPartner: 'proviat' | null =
    data.step2.salesPartner === 'proviat' ? 'proviat' : null;

  let inserted: { id: string };
  try {
    inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(tenants)
        .values({
          shortCode: data.step1.shortCode,
          restaurantName: data.step1.restaurantName,
          contactName: data.step1.contactName,
          contactPhone: data.step1.phone,
          contactEmail: data.step1.email ?? null,
          city: data.step1.city,
          address: data.step1.address ?? null,
          tier: data.step2.tier,
          signedAt,
          contractStartDate: contractStart,
          contractEndDate: contractEnd,
          monthlyFeeKurus: data.step2.monthlyFeeKurus ?? 0,
          salesPartner,
          commissionRatePercent: data.step2.commissionRatePercent ?? 0,
          domain: data.step3.domain,
          serverIdRef: data.step6.serverId,
          configSnapshot: data as never,
          configVersion: 1,
          status: 'onboarding',
          containerStatus: 'not_deployed',
          schemaVersion: 1,
        })
        .returning({ id: tenants.id });

      const row = rows[0];
      if (!row) throw new Error('insert returned no row');

      await tx.insert(auditLog).values({
        userId: session.user.id,
        action: 'tenant.created',
        entityType: 'tenant',
        entityId: row.id,
        metadata: {
          tier: data.step2.tier,
          domain: data.step3.domain,
          shortCode: data.step1.shortCode,
        },
        ipAddress: null,
        userAgent: null,
      });

      return row;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (/duplicate key/i.test(message) || /unique/i.test(message)) {
      // Surface short_code / domain conflicts cleanly.
      const conflicts: Record<string, string> = {};
      if (/short_code/i.test(message)) conflicts.shortCode = 'Bu kısa kod kullanılıyor';
      if (/domain/i.test(message)) conflicts.domain = 'Bu domain kullanılıyor';
      return errorResponse('CONFLICT', 'Kısa kod veya domain zaten kayıtlı', {
        fieldErrors: conflicts,
      });
    }
    // eslint-disable-next-line no-console
    console.error('[tenants][POST] insert failed', err);
    return errorResponse('INTERNAL_ERROR', 'Müşteri oluşturulamadı');
  }

  // Belt-and-braces secondary audit (also catches the IP/UA which the
  // tx-scoped insert deliberately leaves null — the tx is for atomicity,
  // identifiers belong on the request-scoped audit row).
  await recordAudit({
    userId: session.user.id,
    action: 'tenant.created',
    entityType: 'tenant',
    entityId: inserted.id,
    metadata: { shortCode: data.step1.shortCode, tier: data.step2.tier },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
  });

  return successResponse({ tenantId: inserted.id }, { status: 201 });
}
