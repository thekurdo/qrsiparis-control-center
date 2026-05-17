/**
 * Contract Expiry Warning cron job (Phase H11).
 *
 * Schedule (V1.5): günlük 09:00 (Europe/Istanbul).
 *
 * Mantık:
 *   1. status='active' AND NOW() < contract_end_date < NOW()+7d
 *      (sözleşmesi 7 gün içinde dolacak; halen geçerli)
 *   2. Idempotency: aynı tenant için son 24 saat içinde
 *      `contract.expiry_warning` audit row'u yoksa yaz. (Cron günlük
 *      çalıştığı için 24 saatlik pencere "bugün zaten uyardık mı?"
 *      sorusunun cevabıdır.)
 *   3. V1.5: Telegram operasyon kanalına push + tenants.internal_notes
 *      otomatik uyarı satırı (henüz eklenmedi)
 *
 * --- WHY 7-DAY WINDOW INSTEAD OF 30 ---
 * S15 (plan/2026-05-11-control-center-e2e.md) pinned the window at 7 days.
 * The 30-day stub from the original Phase H11 sketch was too noisy in
 * practice — sales tends to renew within the last fortnight and a 30-day
 * heads-up audit row added almost no signal over a 7-day one. The
 * /sistem/cron page copy ("7 gün içinde") matches.
 *
 * --- WHY THE > NOW() LOWER BOUND ---
 * Already-expired tenants are handled by a separate path (status flipped
 * to `cancelled` by an admin) and would otherwise spam the audit log with
 * a "this contract ended yesterday" row every day until manually
 * intervened. We deliberately exclude `contract_end_date < NOW()`.
 *
 * --- WHY APP-LEVEL IDEMPOTENCY INSTEAD OF UNIQUE CONSTRAINT ---
 * audit_log is append-only by trigger (S11). A UNIQUE constraint over
 * (entity_id, action, date_trunc('day', created_at)) would technically
 * work but would require either an INSERT ... ON CONFLICT (which is
 * fine, recordAudit() does not currently support it) or a DB-side
 * unique-violation catch. A pre-SELECT is simpler, keeps recordAudit()
 * insert-only by construction, and is cheap because of the existing
 * `idx_audit_log_entity` index on (entity_type, entity_id).
 *
 * Audit: her warning için `contract.expiry_warning` action'ı.
 * Metadata: { contractEndDate, daysUntilExpiry, shortCode }.
 */

import { and, eq, gt, gte, lt, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { auditLog, tenants } from '@/db/schema';
import { recordAudit } from '@/lib/cc/audit';

const WARNING_WINDOW_DAYS = 7;
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function run(): Promise<{
  flagged: number;
  tenantIds: string[];
}> {
  const expiring = await db
    .select({
      id: tenants.id,
      shortCode: tenants.shortCode,
      contractEndDate: tenants.contractEndDate,
    })
    .from(tenants)
    .where(
      and(
        eq(tenants.status, 'active'),
        gt(tenants.contractEndDate, sql`NOW()`),
        lt(
          tenants.contractEndDate,
          sql`NOW() + INTERVAL '${sql.raw(String(WARNING_WINDOW_DAYS))} days'`,
        ),
      ),
    );

  const flaggedIds: string[] = [];

  for (const t of expiring) {
    // Idempotency: skip if a warning was already written for this tenant
    // within the last 24h. The 24h window matches the cron's daily cadence;
    // a future change to hourly/N-minute cadence will want a tighter
    // window (or the unique-constraint approach mentioned in the header).
    const existing = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'tenant'),
          eq(auditLog.entityId, t.id),
          eq(auditLog.action, 'contract.expiry_warning'),
          gte(
            auditLog.createdAt,
            new Date(Date.now() - IDEMPOTENCY_WINDOW_MS),
          ),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      continue;
    }

    // ms-precision days-until. Floor instead of round so a 6.9-day
    // contract reads as "6 days left" rather than "7 days left", which
    // better matches operator intuition.
    const daysUntilExpiry = Math.max(
      0,
      Math.floor(
        (t.contractEndDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
      ),
    );

    await recordAudit({
      userId: null, // system-driven cron
      action: 'contract.expiry_warning',
      entityType: 'tenant',
      entityId: t.id,
      metadata: {
        shortCode: t.shortCode,
        contractEndDate: t.contractEndDate,
        daysUntilExpiry,
        warningWindowDays: WARNING_WINDOW_DAYS,
      },
    });

    flaggedIds.push(t.id);
  }

  // eslint-disable-next-line no-console
  console.info('[cron/contract-expiry] swept', {
    candidates: expiring.length,
    flagged: flaggedIds.length,
    note: 'Telegram bildirimleri V1.5',
  });

  return { flagged: flaggedIds.length, tenantIds: flaggedIds };
}

/**
 * Alias matching the naming convention used by other cron modules
 * (S9 / `runStuckRecovery`). Keep `run` exported too — older call sites
 * and the V1.5 scheduler wiring use that name.
 */
export const runContractExpiry = run;
