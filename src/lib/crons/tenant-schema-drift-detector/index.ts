/**
 * Tenant Schema Drift Detector cron job (Phase H11).
 *
 * Schedule (V1.5): günlük (paused tenant resume akışında da on-demand
 * çağrılabilir).
 *
 * Mantık:
 *   1. EXPECTED_TENANT_SCHEMA_VERSION sabitini kontrol et. Bu, control-center'ın
 *      bildiği "en son" tenant DB schema sürümüdür ve customer-product
 *      tarafında yeni bir migration release edildiğinde bumplenir (V1.5).
 *   2. status != 'cancelled' AND schema_version < EXPECTED olan tenantları çek.
 *      (Sadece geride kalanları flagleriz; ileride bir tenant'ın daha yeni
 *      bir versiyona "atlamış" olması — gelecekteki bir release adayı için
 *      manuel olarak bumplanmış — drift değildir, beklenen bir durumdur.
 *      Bu yüzden `ne` değil `lt`. Cancelled tenantlar için de uyarı yazmak
 *      operasyonel olarak gürültüdür — onlar zaten yaşam döngülerinin
 *      sonunda, migration almayacaklar.)
 *   3. Her drift'li tenant için:
 *      - 24h idempotency: aynı tenant için son 24 saat içinde
 *        `tenant.schema_drift` audit row'u yoksa yaz. (S15 ile aynı pattern.)
 *      - V1.5: Telegram'da operations kanalına notify
 *      - V1.5: tenant resume akışında pre-check olarak engel olarak çalıştır
 *
 * Bu cron R18'in (IMPL §4) bir parçasıdır: paused tenantlar resume
 * edildiğinde aradaki migration'ları kaçırmış olabilirler. Kalkıştan önce
 * fark edilmesi gerekir.
 *
 * --- WHY 24h IDEMPOTENCY INSTEAD OF UNIQUE CONSTRAINT ---
 * S11 ile aynı: audit_log append-only by trigger, recordAudit() INSERT-only
 * by construction. Pre-SELECT, INSERT ... ON CONFLICT'tan daha basit ve
 * `idx_audit_log_entity` index'ini kullanır. S15 contract-expiry cron ile
 * aynı pattern.
 *
 * --- WHY ACTION NAME 'tenant.schema_drift' (NOT 'tenant.schema_drift_detected') ---
 * V1 noktalı dotted-name kuralı: <entity>.<event>. `schema_drift_detected`
 * geçmiş zamanlı bir cümlecik gibi okunur; `schema_drift` daha tutarlı
 * (cf. `contract.expiry_warning`, `deployment.stuck_recovered`).
 *
 * Audit: her drift için `tenant.schema_drift` action'ı.
 * Metadata: { shortCode, tenantVersion, expectedVersion, status }.
 *
 * Dönüş: { flagged, tenantIds } — bu çalıştırmada YENİ flag edilen sayı +
 * id listesi. Idempotency gate'ine takılan tenantlar dahil değildir
 * (S15 ile aynı kontrat).
 */

import { and, eq, gte, lt, ne } from 'drizzle-orm';

import { db } from '@/db/client';
import { auditLog, tenants } from '@/db/schema';
import { recordAudit } from '@/lib/cc/audit';

/**
 * Control center'ın bildiği "en son" tenant DB schema sürümü.
 * Yeni bir customer-product migration release edildiğinde bu sayı bumplenir.
 *
 * V1 release: 3 — onboarding (1), order-history (2), tier-config (3).
 * V1.5: customer-product side bunu bir yere kayıt etmeli ve bu sabitle
 * release-time'da senkron tutmalı (CI gate). V1'de manuel.
 */
export const EXPECTED_TENANT_SCHEMA_VERSION = 3;

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function run(): Promise<{
  flagged: number;
  tenantIds: string[];
}> {
  // Cancelled tenants are excluded — they will not receive a migration
  // because their containers are torn down. Onboarding/active/paused all
  // qualify: onboarding can still be in flight when a release lands,
  // active is the obvious case, paused is the very case R18 is about.
  const drifters = await db
    .select({
      id: tenants.id,
      shortCode: tenants.shortCode,
      schemaVersion: tenants.schemaVersion,
      status: tenants.status,
    })
    .from(tenants)
    .where(
      and(
        lt(tenants.schemaVersion, EXPECTED_TENANT_SCHEMA_VERSION),
        ne(tenants.status, 'cancelled'),
      ),
    );

  const flaggedIds: string[] = [];

  for (const t of drifters) {
    // Idempotency: skip if a drift warning was already written for this
    // tenant within the last 24h. The 24h window matches the cron's daily
    // cadence; mirrors S15's contract-expiry gate.
    const existing = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'tenant'),
          eq(auditLog.entityId, t.id),
          eq(auditLog.action, 'tenant.schema_drift'),
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

    await recordAudit({
      userId: null, // system-driven cron
      action: 'tenant.schema_drift',
      entityType: 'tenant',
      entityId: t.id,
      metadata: {
        shortCode: t.shortCode,
        tenantVersion: t.schemaVersion,
        expectedVersion: EXPECTED_TENANT_SCHEMA_VERSION,
        status: t.status,
      },
    });

    flaggedIds.push(t.id);
  }

  if (drifters.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[cron/tenant-schema-drift-detector] swept', {
      candidates: drifters.length,
      flagged: flaggedIds.length,
      expectedVersion: EXPECTED_TENANT_SCHEMA_VERSION,
      note: 'Telegram bildirimleri V1.5',
    });
  }

  return { flagged: flaggedIds.length, tenantIds: flaggedIds };
}

/**
 * Alias matching the naming convention used by other cron modules
 * (S9 / `runStuckRecovery`, S15 / `runContractExpiry`).
 */
export const runSchemaDriftDetector = run;
