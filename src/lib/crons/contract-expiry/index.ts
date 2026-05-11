/**
 * Contract Expiry Warning cron job (Phase H11 stub).
 *
 * Schedule (V1.5): günlük 09:00 (Europe/Istanbul).
 *
 * Mantık:
 *   1. status='active' AND contract_end_date BETWEEN NOW() AND NOW()+30d
 *   2. Her bir tenant için audit_log'a `tenant.contract_expiring` action'ı
 *      yaz (admin'in /sistem/audit sayfasında görmesi için)
 *   3. V1.5: Telegram'a operasyon kanalına push (eklenmedi)
 *   4. V1.5: tenants.internal_notes alanına otomatik bir uyarı satırı ekle
 *      (mevcut V1'de notes manuel düzenleniyor)
 *
 * Dönüş: işaretlenen tenant sayısı + id listesi (debug için).
 */

import { and, eq, gte, lte, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { tenants } from '@/db/schema';
import { recordAudit } from '@/lib/cc/audit';

const WARNING_WINDOW_DAYS = 30;

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
        gte(tenants.contractEndDate, sql`NOW()`),
        lte(
          tenants.contractEndDate,
          sql`NOW() + INTERVAL '${sql.raw(String(WARNING_WINDOW_DAYS))} days'`,
        ),
      ),
    );

  for (const t of expiring) {
    await recordAudit({
      userId: null, // system-driven cron
      action: 'tenant.contract_expiring',
      entityType: 'tenant',
      entityId: t.id,
      metadata: {
        shortCode: t.shortCode,
        contractEndDate: t.contractEndDate,
        warningWindowDays: WARNING_WINDOW_DAYS,
      },
    });
  }

  // eslint-disable-next-line no-console
  console.info('[cron/contract-expiry] flagged', {
    count: expiring.length,
    note: 'Telegram bildirimleri V1.5',
  });

  return { flagged: expiring.length, tenantIds: expiring.map((t) => t.id) };
}
