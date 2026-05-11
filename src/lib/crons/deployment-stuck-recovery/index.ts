/**
 * Deployment Stuck Recovery cron job (Phase H11 stub).
 *
 * Schedule (V1.5): her 1 dakika.
 *
 * Mantık:
 *   30 dakikadan uzun süredir `status='in_progress'` kalan deployment'ları
 *   zombileşmiş kabul edip `status='failed'` + `error_code='STUCK_TIMEOUT'`
 *   olarak işaretler. Bu, worker.ts içerisindeki setInterval ile zaten
 *   yapılan bir korumadır; bu modül aynı mantığı standalone fonksiyon
 *   olarak sunar (V1.5 cron wiring tek bir kaynaktan beslesin diye).
 *
 * Neden ayrı bir modül var: worker.ts iç döngüsü process restart sonrası
 * bir kaç saniye geç başlayabiliyor. Cron versiyonu ek garanti — duplicate
 * update zarar vermez (UPDATE statement idempotent: zaten failed olanları
 * tekrar failed yapmaz çünkü WHERE clause status'u filtreler).
 *
 * Audit: her zombieleşmiş deploy için `deployment.stuck_recovered` action'ı.
 */

import { and, eq, lt, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { deployments } from '@/db/schema';
import { recordAudit } from '@/lib/cc/audit';

const STUCK_THRESHOLD_MINUTES = 30;

export async function run(): Promise<{ recovered: number }> {
  const stuck = await db
    .select({
      id: deployments.id,
      tenantId: deployments.tenantId,
      startedAt: deployments.startedAt,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.status, 'in_progress'),
        lt(
          deployments.startedAt,
          sql`NOW() - INTERVAL '${sql.raw(String(STUCK_THRESHOLD_MINUTES))} minutes'`,
        ),
      ),
    );

  if (stuck.length === 0) {
    return { recovered: 0 };
  }

  for (const d of stuck) {
    await db
      .update(deployments)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorCode: 'STUCK_TIMEOUT',
        errorMessage: `Deployment ${STUCK_THRESHOLD_MINUTES}dk üzeri in_progress kaldı; cron tarafından failed olarak işaretlendi.`,
      })
      .where(eq(deployments.id, d.id));

    await recordAudit({
      userId: null,
      action: 'deployment.stuck_recovered',
      entityType: 'deployment',
      entityId: d.id,
      metadata: {
        tenantId: d.tenantId,
        startedAt: d.startedAt,
        thresholdMinutes: STUCK_THRESHOLD_MINUTES,
      },
    });
  }

  // eslint-disable-next-line no-console
  console.warn('[cron/deployment-stuck-recovery] recovered', {
    count: stuck.length,
  });

  return { recovered: stuck.length };
}
