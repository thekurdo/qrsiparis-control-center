/**
 * Tenant Health Check cron job (Phase H11 stub).
 *
 * Schedule (V1.5): her 5 dakika.
 *
 * Mantık:
 *   1. status='active' AND container_status='running' tüm tenantları çek
 *   2. Her biri için `https://<domain>/api/health` adresine kısa timeout
 *      ile GET at
 *   3. Yanıt 200 ve `{ status: 'ok' }` ise tenant servered server için
 *      `last_health_status='healthy'` yaz
 *   4. Hata / timeout ise `'critical'`, 5xx / yavaş ise `'degraded'` yaz
 *   5. Her server için `last_health_check_at` güncelle
 *
 * V1: scheduler henüz yok. `run()` fonksiyonu standalone import edilip
 * elle çağrılabilir; gerçek tetikleme V1.5'te node-cron / BullMQ
 * repeatable job olarak eklenecek.
 */

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { tenants } from '@/db/schema';

const HEALTH_TIMEOUT_MS = 5_000;

interface HealthResult {
  tenantId: string;
  domain: string;
  ok: boolean;
  status: 'healthy' | 'degraded' | 'critical';
  latencyMs?: number;
  error?: string;
}

async function probeTenant(
  tenantId: string,
  domain: string,
): Promise<HealthResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${domain}/api/health`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { tenantId, domain, ok: false, status: 'degraded', latencyMs };
    }
    return { tenantId, domain, ok: true, status: 'healthy', latencyMs };
  } catch (err) {
    return {
      tenantId,
      domain,
      ok: false,
      status: 'critical',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function run(): Promise<{
  checked: number;
  results: HealthResult[];
}> {
  const active = await db
    .select({ id: tenants.id, domain: tenants.domain })
    .from(tenants)
    .where(eq(tenants.status, 'active'));

  const results = await Promise.all(
    active.map((t) => probeTenant(t.id, t.domain)),
  );

  // V1.5: yan etki olarak servers.lastHealthStatus güncellenecek.
  // V1'de stub: sadece sonuçları döndürüyoruz.
  // eslint-disable-next-line no-console
  console.info('[cron/health-check] probed', {
    checked: results.length,
    healthy: results.filter((r) => r.status === 'healthy').length,
    degraded: results.filter((r) => r.status === 'degraded').length,
    critical: results.filter((r) => r.status === 'critical').length,
  });

  return { checked: results.length, results };
}
