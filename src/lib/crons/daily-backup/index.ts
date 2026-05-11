/**
 * Daily Backup cron job (Phase H11 stub).
 *
 * Schedule (V1.5): günlük 03:00 (Europe/Istanbul).
 *
 * Mantık (V1.5 hedefi):
 *   1. status='active' tüm tenantlar
 *   2. Her tenant container'ında SSH ile backup script çağrısı:
 *        sqlite3 /data/qrsiparis.db ".backup '/data/backups/<short>-<ts>.db'"
 *   3. Backup dosyasını DEFAULT_BACKUP_PATH altında bir bucket'a kopyala
 *   4. audit_log'a `tenant.backup_completed` veya `tenant.backup_failed`
 *      yaz
 *
 * V1 stub: SSH client + backup script wrapper henüz yok. Bu fonksiyon
 * sadece eligible tenant listesini çekiyor ve log'a yazıyor; gerçek
 * dosya operasyonu V1.5'te eklenecek.
 *
 * Idempotency: dosya adında timestamp olduğu için aynı gün içinde
 * birden fazla çağrı problem değil — son çalıştırma kalıcı olur.
 */

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { tenants } from '@/db/schema';

interface BackupResult {
  tenantId: string;
  shortCode: string;
  ok: boolean;
  reason?: string;
}

async function backupTenant(
  tenantId: string,
  shortCode: string,
): Promise<BackupResult> {
  // V1.5:
  //   const path = `${BACKUP_ROOT}/${shortCode}-${ts}.db`;
  //   await sshExec(serverId, `sqlite3 /data/qrsiparis.db ".backup '${path}'"`);
  //   await uploadToBucket(path);
  return {
    tenantId,
    shortCode,
    ok: false,
    reason: 'SSH backup script henüz yok — V1.5',
  };
}

export async function run(): Promise<{
  attempted: number;
  results: BackupResult[];
}> {
  const active = await db
    .select({ id: tenants.id, shortCode: tenants.shortCode })
    .from(tenants)
    .where(eq(tenants.status, 'active'));

  const results = await Promise.all(
    active.map((t) => backupTenant(t.id, t.shortCode)),
  );

  // eslint-disable-next-line no-console
  console.info('[cron/daily-backup] dry-run completed', {
    attempted: results.length,
    note: 'SSH backup wrapper V1.5 — no files written',
  });

  return { attempted: results.length, results };
}
