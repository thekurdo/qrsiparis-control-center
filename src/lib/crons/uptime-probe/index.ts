/**
 * Uptime Probe cron job (Phase H12 — observability spike).
 *
 * Schedule: every 60 seconds (BullMQ repeatable job; registered in
 * `src/workers/deployment-worker.ts` at boot).
 *
 * Mantık:
 *   1. status='active' tüm tenantları çek (her tick'te bir kez).
 *   2. Her tenant'ın `https://<domain>/api/health` adresine 5s timeout
 *      ile paralel GET at.
 *   3. Process-local Map<tenantId, number> üzerinden ardışık fail
 *      sayacını güncelle:
 *        - 200 → counter 0'a sıfırla. Eğer önceden alarm
 *          gönderildiyse (counter ≥ N idi) `uptime.recovered`
 *          audit + Slack ✅ mesajı.
 *        - non-200 / timeout → counter += 1. Counter tam olarak
 *          N (default 3) olduğunda `uptime.alert` audit + Slack 🚨
 *          mesajı (THRESHOLD CROSS — sadece bir kez).
 *   4. Slack webhook gracefully no-op olur `SLACK_ALERT_WEBHOOK_URL`
 *      env unset ise; audit row her zaman yazılır.
 *
 * --- WHY IN-MEMORY (NOT REDIS) ---
 * V1.5 simplicity. Worker restart counters'ı sıfırlar; bu kabul edilebilir
 * çünkü restart implies operator already aware of trouble (deploy/reboot).
 * Tek-instance worker garantisi BullMQ side'da deployment queue ile zaten
 * var; ikinci worker process çalışmazsa tek bir global counter map
 * tutarlıdır.
 *
 * --- WHY EXACTLY-AT-THRESHOLD ALERT (NOT >= N) ---
 * `consecutiveFails === N` testi alarmın sadece BİR kez (threshold-cross
 * anında) gönderilmesini garantiler. N+1, N+2 tick'lerinde counter artmaya
 * devam ediyor ama yeniden Slack mesajı çıkmıyor — Slack spam'ı önlüyor.
 * Recovery sinyali (200 dönüş) bayrağı temizler; sonraki bir N-fail
 * sequence'i tekrar alarm gönderir.
 *
 * --- WHY `status='active'` ONLY ---
 * Onboarding tenant henüz domain DNS'i yayılmamış olabilir; paused
 * tenant'lar kasten down (operator istedi); cancelled tenant'lar deleted-
 * pending. Yalnızca aktif tenantlar customer-facing — bunlar bizi
 * gerçekten alarm vermesi gereken hedefler.
 *
 * --- WHY 5s TIMEOUT ---
 * `health-check` cron'u ile aynı — tutarlı timeout budget. /api/health
 * cheap olmalı (DB ping yok, sadece process liveness); 5s'i aşan response
 * genellikle slow disk / OOM / proxy çökmüş; bunlar zaten "down" sayılır.
 *
 * --- SLACK WEBHOOK PAYLOAD FORMAT ---
 * `{ text: "..." }` Slack incoming-webhook minimum payload'ı. Block-kit
 * yok (V1.5 simplicity). Operator webhook URL'sini Coolify CC env'ine
 * `SLACK_ALERT_WEBHOOK_URL` olarak yapıştırır; format
 * `https://hooks.slack.com/services/T.../B.../...`.
 */

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { tenants } from '@/db/schema';
import { recordAudit } from '@/lib/cc/audit';

const HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_FAIL_THRESHOLD = 3;

interface UptimeProbeOptions {
  /** Number of consecutive failures before alerting. Default 3. */
  threshold?: number;
}

interface ProbeResult {
  tenantId: string;
  shortCode: string;
  domain: string;
  ok: boolean;
  httpStatus: number;
  error?: string;
}

/**
 * Process-local state. The worker process is the single source of truth for
 * consecutive-failure counters. A worker restart (deploy / OOM kill) clears
 * the state — see header rationale.
 *
 * `consecutiveFails` → number of back-to-back non-200 results we've observed.
 * `alertedAt` → timestamp at which we last sent a 🚨 message. Used to flag
 *               that a `uptime.recovered` row + ✅ message should fire when
 *               the tenant returns 200. Undefined = not currently alarmed.
 */
interface TenantUptimeState {
  consecutiveFails: number;
  alertedAt: Date | undefined;
  lastHealthHttp: number;
}

// Module-level globals are process-local; exported only for tests.
export const uptimeState = new Map<string, TenantUptimeState>();

/** Reset internal state — test helper. */
export function __resetUptimeState(): void {
  uptimeState.clear();
}

async function probeTenant(
  tenantId: string,
  shortCode: string,
  domain: string,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${domain}/api/health`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    return {
      tenantId,
      shortCode,
      domain,
      ok: res.ok,
      httpStatus: res.status,
    };
  } catch (err) {
    return {
      tenantId,
      shortCode,
      domain,
      ok: false,
      // `0` is a sentinel for "no HTTP response at all" — DNS / TCP / abort.
      httpStatus: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Best-effort Slack incoming-webhook POST. No-op when the env var is unset.
 *
 * Why don't we surface fetch errors: Slack outage / webhook revocation should
 * not block the audit-row write or stop the next tick. We log to stderr and
 * carry on. The audit_log row is the durable record; Slack is a delivery
 * convenience.
 */
async function sendSlackMessage(text: string): Promise<void> {
  const url = process.env['SLACK_ALERT_WEBHOOK_URL'];
  if (!url) return; // graceful no-op when unset
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cron/uptime-probe] slack post failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

interface ProbeTarget {
  tenantId: string;
  shortCode: string;
  restaurantName: string;
  domain: string;
}

export async function run(
  options: UptimeProbeOptions = {},
): Promise<{
  probed: number;
  alerts: number;
  recoveries: number;
  results: ProbeResult[];
}> {
  const threshold = options.threshold ?? DEFAULT_FAIL_THRESHOLD;

  const active: ProbeTarget[] = await db
    .select({
      tenantId: tenants.id,
      shortCode: tenants.shortCode,
      restaurantName: tenants.restaurantName,
      domain: tenants.domain,
    })
    .from(tenants)
    .where(eq(tenants.status, 'active'));

  // Parallel fan-out — each probe has its own 5s timeout so worst-case wall
  // clock for the tick is ~5s regardless of fleet size.
  const results = await Promise.all(
    active.map((t) => probeTenant(t.tenantId, t.shortCode, t.domain)),
  );

  let alerts = 0;
  let recoveries = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const tenant = active[i];
    if (!result || !tenant) continue;

    const prev = uptimeState.get(result.tenantId) ?? {
      consecutiveFails: 0,
      alertedAt: undefined,
      lastHealthHttp: 0,
    };

    if (result.ok) {
      // ---- Recovery branch -------------------------------------------------
      const wasAlerted = prev.alertedAt !== undefined;
      uptimeState.set(result.tenantId, {
        consecutiveFails: 0,
        alertedAt: undefined,
        lastHealthHttp: result.httpStatus,
      });
      if (wasAlerted) {
        recoveries += 1;
        await recordAudit({
          userId: null,
          action: 'uptime.recovered',
          entityType: 'tenant',
          entityId: result.tenantId,
          metadata: {
            tenantId: result.tenantId,
            shortCode: result.shortCode,
            domain: result.domain,
            lastHealthHttp: result.httpStatus,
          },
        });
        await sendSlackMessage(
          `✅ ${tenant.restaurantName} (${result.domain}) recovered`,
        );
      }
    } else {
      // ---- Failure branch --------------------------------------------------
      const nextFails = prev.consecutiveFails + 1;
      const crossedThreshold =
        prev.alertedAt === undefined && nextFails === threshold;

      uptimeState.set(result.tenantId, {
        consecutiveFails: nextFails,
        alertedAt: crossedThreshold ? new Date() : prev.alertedAt,
        lastHealthHttp: result.httpStatus,
      });

      if (crossedThreshold) {
        alerts += 1;
        await recordAudit({
          userId: null,
          action: 'uptime.alert',
          entityType: 'tenant',
          entityId: result.tenantId,
          metadata: {
            tenantId: result.tenantId,
            shortCode: result.shortCode,
            domain: result.domain,
            consecutiveFails: nextFails,
            lastHealthHttp: result.httpStatus,
          },
        });
        await sendSlackMessage(
          `🚨 ${tenant.restaurantName} (${result.domain}) is down — HTTP ${result.httpStatus}, ${nextFails} consecutive failures`,
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.info('[cron/uptime-probe] ticked', {
    probed: results.length,
    alerts,
    recoveries,
    threshold,
  });

  return { probed: results.length, alerts, recoveries, results };
}

/**
 * Alias matching the naming convention used by sibling cron modules
 * (`runDailyBackup`, `runStuckRecovery`, `runContractExpiry`, ...).
 */
export const runUptimeProbe = run;
