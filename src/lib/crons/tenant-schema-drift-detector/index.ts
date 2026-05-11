/**
 * Tenant Schema Drift Detector cron job (Phase H11 stub).
 *
 * Schedule (V1.5): günlük (paused tenant resume akışında da on-demand
 * çağrılabilir).
 *
 * Mantık:
 *   1. CURRENT_SCHEMA_VERSION sabitini kontrol et (V1 = 1).
 *   2. tenants.schema_version != CURRENT olan tüm kayıtları çek.
 *   3. Her drift'li tenant için:
 *      - audit_log'a `tenant.schema_drift_detected` yaz
 *      - V1.5: Telegram'da operations kanalına notify
 *      - V1.5: tenant resume akışında pre-check olarak engel olarak çalıştır
 *
 * Bu cron R18'in (IMPL §4) bir parçasıdır: paused tenantlar resume
 * edildiğinde aradaki migration'ları kaçırmış olabilirler. Kalkıştan önce
 * fark edilmesi gerekir.
 *
 * Dönüş: drift'te olan tenant id listesi (audit ek olarak yazılır).
 */

import { ne } from 'drizzle-orm';

import { db } from '@/db/client';
import { tenants } from '@/db/schema';
import { recordAudit } from '@/lib/cc/audit';

/**
 * Control center'ın bildiği "en son" tenant DB schema sürümü.
 * Yeni bir tenant migration eklendiğinde bu sayı bumplenir.
 */
export const CURRENT_SCHEMA_VERSION = 1;

export async function run(): Promise<{
  drifted: number;
  tenantIds: string[];
}> {
  const drifted = await db
    .select({
      id: tenants.id,
      shortCode: tenants.shortCode,
      schemaVersion: tenants.schemaVersion,
      status: tenants.status,
    })
    .from(tenants)
    .where(ne(tenants.schemaVersion, CURRENT_SCHEMA_VERSION));

  for (const t of drifted) {
    await recordAudit({
      userId: null,
      action: 'tenant.schema_drift_detected',
      entityType: 'tenant',
      entityId: t.id,
      metadata: {
        shortCode: t.shortCode,
        currentVersion: CURRENT_SCHEMA_VERSION,
        tenantVersion: t.schemaVersion,
        status: t.status,
      },
    });
  }

  if (drifted.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[cron/tenant-schema-drift-detector] drift detected', {
      count: drifted.length,
      currentVersion: CURRENT_SCHEMA_VERSION,
    });
  }

  return { drifted: drifted.length, tenantIds: drifted.map((t) => t.id) };
}
