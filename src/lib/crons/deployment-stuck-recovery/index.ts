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
 * BullMQ temizliği: her zombi deployment için `removeDeploymentJob(id)`
 * çağırırız. Bu, `bull:deployments:<id>` hash ile birlikte ilgili active/
 * waiting/delayed listelerinden de düşürür. Worker hayatta ise süregelen
 * `executeDeployment` koşusu DB üzerinden hâlâ devam edebilir, ama row
 * artık `failed` olduğu için tamamlanma anındaki UPDATE WHERE clause'a
 * çarpıp no-op olacaktır (status='in_progress' yok artık).
 *
 * Idempotency: ikinci çalıştırmada SELECT zaten 0 satır döner çünkü WHERE
 * `status='in_progress'`. Audit hattı da bu yüzden tekrar yazılmaz. Job
 * temizleme `removeDeploymentJob` zaten yokluk durumunda `false` döner.
 *
 * Audit: her zombileşmiş deploy için `deployment.stuck_recovered` action'ı.
 */

import { and, eq, lt, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { deployments } from '@/db/schema';
import { recordAudit } from '@/lib/cc/audit';
import { removeDeploymentJob } from '@/lib/deploy/queue';

const STUCK_THRESHOLD_MINUTES = 30;

/**
 * Sweep stuck deployments. Returns the count of rows recovered this run
 * so the V1.5 scheduler can emit a metric. Safe to call concurrently —
 * the UPDATE narrows the WHERE clause to the still-in_progress row, so
 * a parallel invocation won't double-stamp.
 */
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

  let recovered = 0;
  for (const d of stuck) {
    // The UPDATE gates on status='in_progress' so a row that was already
    // flipped failed by a concurrent worker/cron tick is a no-op here.
    // `returning` lets us discover whether THIS invocation owned the
    // transition; we only emit the audit + BullMQ cleanup on a real
    // transition to keep the audit log clean of duplicates.
    const updated = await db
      .update(deployments)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorCode: 'STUCK_TIMEOUT',
        errorMessage: `Deployment ${STUCK_THRESHOLD_MINUTES}dk üzeri in_progress kaldı; cron tarafından failed olarak işaretlendi.`,
      })
      .where(
        and(
          eq(deployments.id, d.id),
          eq(deployments.status, 'in_progress'),
        ),
      )
      .returning({ id: deployments.id });

    if (updated.length === 0) {
      // Lost the race against another worker/cron tick. Don't double-audit.
      continue;
    }

    // Best-effort BullMQ cleanup. A worker that already crashed leaves
    // the `bull:deployments:<id>` hash in Redis (and the job in active/
    // failed lists depending on how it died). We strip it so the queue's
    // active count reflects reality. Failure here is non-fatal — the DB
    // row is the source of truth.
    try {
      await removeDeploymentJob(d.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[cron/deployment-stuck-recovery] BullMQ remove failed for ${d.id}`,
        err,
      );
    }

    await recordAudit({
      userId: null,
      action: 'deployment.stuck_recovered',
      entityType: 'deployment',
      entityId: d.id,
      metadata: {
        tenantId: d.tenantId,
        startedAt: d.startedAt,
        thresholdMinutes: STUCK_THRESHOLD_MINUTES,
        errorCode: 'STUCK_TIMEOUT',
      },
    });

    recovered += 1;
  }

  if (recovered > 0) {
    // eslint-disable-next-line no-console
    console.warn('[cron/deployment-stuck-recovery] recovered', {
      count: recovered,
    });
  }

  return { recovered };
}

/**
 * Alias matching the naming convention used by other cron modules and the
 * spec for S9 (`runStuckRecovery`). Keep `run` exported too — older call
 * sites and the V1.5 scheduler wiring use that name.
 */
export const runStuckRecovery = run;
