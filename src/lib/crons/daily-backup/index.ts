/**
 * Daily Backup cron job (Phase H11 — S19 implementation).
 *
 * Schedule (V1.5): günlük 03:00 (Europe/Istanbul).
 *
 * Mantık:
 *   1. status='active' tüm tenantları çek (server bilgisi ile JOIN ederek
 *      SSH bağlantı koordinatlarını birlikte al)
 *   2. Her tenant için 24h idempotency gate:
 *        - Son 24 saatte `backup.completed` audit row'u varsa atla.
 *        - (S15 / S16 ile aynı pattern; recordAudit() INSERT-only.)
 *   3. SSH bağlantısı kur (mock mode'da getSshClient() SshMockClient döner;
 *      mock dictionary `pg_dump`-prefixed komutlara canned çıktı verir).
 *   4. `pg_dump` çalıştır; çıktı `backupSize` olarak ölçülür.
 *   5. Dosya adı pattern'i: `tenant-{shortCode}-{YYYYMMDD}.sql`.
 *      (V1.5'te gzip'li `.sql.gz` haline gelecek — host script
 *      `scripts/backup-all-tenants.sh` zaten gzip ediyor; cron sadece
 *      audit kayıt + komut tetikleyici, gerçek dosya yönetimi host
 *      tarafında. V1'de tek bir `pg_dump` komutu yeterli çünkü mock
 *      kanonik çıktıyı zaten dönüyor.)
 *   6. Başarılı ise `backup.completed`, hata ise `backup.failed` audit
 *      row'u yaz. Metadata: `{ tenantId, shortCode, filename, backupSize,
 *      serverId }` (failed ise ek olarak `errorMessage`).
 *
 * Audit name'ler:
 *   - `backup.completed` — başarılı pg_dump + audit yazımı
 *   - `backup.failed`    — SSH connect / exec hatası (audit yine yazılır;
 *                          24h idempotency gate sadece `.completed`'a
 *                          bakar, çünkü ardışık `.failed`'ler ops için
 *                          önemli sinyal; aynı tenant her cron tick'te
 *                          başarısız olursa log dolar ama bu kasıtlı)
 *
 * --- WHY 24h IDEMPOTENCY ON `backup.completed` ONLY ---
 * Cron günde bir kez çalışıyor (V1.5'te 03:00). İki başarılı backup aynı
 * gün içinde çakışmamalı (host disk maliyeti + replikasyon penceresi
 * büyütür). Ardışık `backup.failed`'ler ise tam tersine her tick'te
 * gözükmeli — bu noisy gibi görünür, ama silent failure'dan iyidir; ops
 * 24 saatte 1 değil her cron tick'te (V1.5 schedule'a göre günde 1) bir
 * uyarı görür, ve audit_log üzerindeki tek-tek satırlar root-cause analizi
 * için tarihsel bir trail sunar. S15/S16 pattern bu nokta için 24h gate
 * uyguluyor; backup için sadece `.completed`'da gate'leyerek `.failed`'i
 * öğrenilebilir bir sinyal olarak korur.
 *
 * --- WHY PG_DUMP (NOT SQLITE3) ---
 * Header'daki orijinal stub `sqlite3 .backup` öneriyor. Ancak
 * `client-mock.ts`'in MOCK_RESPONSES dictionary'si HEM `pg_dump` HEM
 * `sqlite3`-prefixed komutları aynı canned çıktıyla karşılar. Tenant
 * container'larındaki gerçek DB SQLite olsa da `pg_dump` daha fleet-wide
 * bir komut (control-center kendi PostgreSQL'ini de dump etmek
 * isteyecek — `scripts/backup-all-tenants.sh` İÇ panel için pg_dump
 * çalıştırıyor §41-54). V1.5'te per-tenant SQLite backup ile per-fleet
 * pg_dump aynı cron'da çağrılabilir; şimdilik tek bir `pg_dump`
 * placeholder yeterli (mock'un ardındaki gerçek komut değişebilir,
 * audit row'un şekli sabit kalır).
 *
 * --- WHY FILENAME PATTERN tenant-{short}-{YYYYMMDD}.sql ---
 * Plan §5.S19'da pinlendi. YYYYMMDD timestamp ardışık günlerin
 * üst-üste binmesini engeller; aynı gün ikinci bir çağrı 24h idempotency
 * gate'ine takılır, dosya adı yarışı oluşmaz. Saatlik cadence'a geçilirse
 * filename'i `tenant-{short}-{YYYYMMDDHH}.sql` haline getirip gate'i
 * saatlik yapmak gerekir (S15 header'da aynı not var).
 *
 * --- WHY FILE PURGE IS A NO-OP IN V1 ---
 * Plan'daki retention sub-test "30 günden eski backup dosyalarını sil"
 * der ama audit_log immutable (S11 trigger). Backup-FILES için ayrı bir
 * mekanizma yok (V1'de `backups` tablosu YOK; SQL dump shell script
 * `find -mtime +30 -delete` ile temizliyor — host-side). Cron Node
 * sürecinde dosya purging YAPMAZ; host shell script
 * `scripts/backup-all-tenants.sh` zaten retention'a sahip
 * (`BACKUP_RETENTION_DAYS=30`, line 9). Cron sadece tetikleme +
 * audit yazma — disk taraması out-of-scope.
 *
 * --- WHY PRIVATE KEY DECRYPT IS SKIPPED IN MOCK MODE ---
 * S3'teki docker-stats route ile aynı pattern: mock SSH client private
 * key'i okumaz, fixture `'fake-iv:fake-tag:fake-cipher'` değerini seed
 * eder ki bu decrypt() çağrısında çöker. TEST_MODE='mock' iken decrypt'i
 * atlayıp boş string geçiyoruz.
 *
 * --- DOWNSTREAM (S13 — pause/resume/cancel) ---
 * `status='active'` filter'ı PAUSED ve CANCELLED tenantları zaten
 * dışlar. Pausing eden bir tenant artık backup almaz (containers durdu,
 * pg_dump connection refused dönecek anyway). Cancelled için de geçerli.
 * Bu yüzden S13'ün cancel akışı bu cron için ekstra bir handler gerektirmez
 * — yalnızca filtre üzerinden organik bir şekilde devre dışı kalır.
 *
 * --- AUDIT TABLE COMPATIBILITY ---
 * S11 trigger audit_log INSERT'e izin verir; UPDATE/DELETE rejected.
 * recordAudit() yalnızca INSERT yapar, dolayısıyla bu cron S11 kontratıyla
 * uyumlu (S15/S16 ile aynı). Retry / re-run aynı 24h içinde ikinci satır
 * yazmaz — DB-level değil app-level gate, S15 header'ında "pre-SELECT
 * INSERT'ten ucuz ve recordAudit()'i INSERT-only by construction tutar"
 * argümanı geçerli.
 */

import { and, eq, gte } from 'drizzle-orm';

import { db } from '@/db/client';
import { auditLog, servers, tenants } from '@/db/schema';
import { recordAudit } from '@/lib/cc/audit';
import { decryptNullable } from '@/lib/crypto/aes-gcm';
import { getSshClient } from '@/lib/ssh';

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface BackupResult {
  tenantId: string;
  shortCode: string;
  ok: boolean;
  skipped?: boolean;
  filename?: string;
  backupSize?: number;
  reason?: string;
}

/**
 * Compute the canonical backup filename for a tenant. YYYYMMDD UTC so two
 * runs in the same calendar day land on the same name (idempotency back-stop,
 * even though the 24h audit gate is the primary mechanism).
 */
function backupFilename(shortCode: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `tenant-${shortCode}-${yyyy}${mm}${dd}.sqlite.gz`;
}

interface BackupTarget {
  tenantId: string;
  shortCode: string;
  serverId: string;
  host: string;
  port: number;
  username: string;
  privateKeyEncrypted: string | null;
}

async function backupOne(t: BackupTarget): Promise<BackupResult> {
  // Idempotency: skip if a `backup.completed` already exists in the last 24h.
  // We DON'T gate on `backup.failed` — see header rationale.
  const recent = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'tenant'),
        eq(auditLog.entityId, t.tenantId),
        eq(auditLog.action, 'backup.completed'),
        gte(auditLog.createdAt, new Date(Date.now() - IDEMPOTENCY_WINDOW_MS)),
      ),
    )
    .limit(1);
  if (recent.length > 0) {
    return {
      tenantId: t.tenantId,
      shortCode: t.shortCode,
      ok: true,
      skipped: true,
      reason: 'already backed up within 24h',
    };
  }

  // Skip decrypt in mock mode — the fixture seeds a placeholder blob that
  // would throw if passed to decrypt(). The mock client ignores the key
  // anyway. Mirrors src/app/api/internal/servers/[id]/docker-stats/route.ts.
  let privateKey = '';
  if (process.env['TEST_MODE'] !== 'mock') {
    try {
      privateKey = decryptNullable(t.privateKeyEncrypted) ?? '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'decrypt failed';
      await recordAudit({
        userId: null,
        action: 'backup.failed',
        entityType: 'tenant',
        entityId: t.tenantId,
        metadata: {
          tenantId: t.tenantId,
          shortCode: t.shortCode,
          serverId: t.serverId,
          errorMessage: `SSH key decrypt: ${msg}`,
        },
      });
      return {
        tenantId: t.tenantId,
        shortCode: t.shortCode,
        ok: false,
        reason: msg,
      };
    }
    if (!privateKey) {
      await recordAudit({
        userId: null,
        action: 'backup.failed',
        entityType: 'tenant',
        entityId: t.tenantId,
        metadata: {
          tenantId: t.tenantId,
          shortCode: t.shortCode,
          serverId: t.serverId,
          errorMessage: 'server has no SSH key configured',
        },
      });
      return {
        tenantId: t.tenantId,
        shortCode: t.shortCode,
        ok: false,
        reason: 'no SSH key',
      };
    }
  }

  const filename = backupFilename(t.shortCode);
  const client = getSshClient();
  try {
    await client.connect({
      host: t.host,
      port: t.port,
      username: t.username,
      privateKey,
    });
    // Tenant DBs are SQLite (one per container) at /data/db.sqlite.
    // We run `sqlite3 .backup` inside the tenant container, then copy
    // the resulting file out to a host-side daily backup directory,
    // then gzip. The host directory `/var/backups/qrsiparis/` is
    // created with `mkdir -p` on every run (idempotent).
    //
    // Container lookup: Coolify names the tenant container as
    // `{coolifyAppUuid}-{ts}`. We grep `docker ps` by the tenant's
    // short_code-derived storage volume label
    // (volume name pattern: `{coolifyAppUuid}-{shortCode}-data`).
    //
    // Mock mode: ssh client returns canned output. We still go through
    // the same command list so the audit row metadata is shaped
    // identically to prod.
    const datestamp = backupFilename(t.shortCode).match(/(\d{8})/)?.[1] ?? '00000000';
    const hostPath = `/var/backups/qrsiparis/tenant-${t.shortCode}-${datestamp}.sqlite.gz`;
    const cmd = [
      `mkdir -p /var/backups/qrsiparis`,
      // Find the tenant's Coolify container by its persistent volume
      `CN=$(docker ps --format '{{.Names}}' | while read c; do docker inspect "$c" --format '{{range .Mounts}}{{.Name}} {{end}}' 2>/dev/null | grep -q "${t.shortCode}-data" && { echo "$c"; break; }; done)`,
      `[ -z "$CN" ] && { echo "no container for ${t.shortCode}" >&2; exit 1; }`,
      // SQLite hot backup inside the container; .backup is atomic
      `docker exec "$CN" sqlite3 /data/db.sqlite ".backup /tmp/db-backup.sqlite"`,
      // Copy out + gzip + drop the in-container temp file
      `docker cp "$CN:/tmp/db-backup.sqlite" /tmp/db-backup-${t.shortCode}.sqlite`,
      `docker exec "$CN" rm -f /tmp/db-backup.sqlite`,
      `gzip -9 -c /tmp/db-backup-${t.shortCode}.sqlite > ${hostPath}`,
      `rm -f /tmp/db-backup-${t.shortCode}.sqlite`,
      `stat -c '%s' ${hostPath}`,
    ].join(' && ');
    const result = await client.exec(cmd);
    await client.disconnect();

    if (result.exitCode !== 0) {
      await recordAudit({
        userId: null,
        action: 'backup.failed',
        entityType: 'tenant',
        entityId: t.tenantId,
        metadata: {
          tenantId: t.tenantId,
          shortCode: t.shortCode,
          serverId: t.serverId,
          filename,
          errorMessage: `pg_dump exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
        },
      });
      return {
        tenantId: t.tenantId,
        shortCode: t.shortCode,
        ok: false,
        reason: `pg_dump exit ${result.exitCode}`,
      };
    }

    // The final command in the chain is `stat -c '%s' <path>` so the last
    // non-empty stdout line is the gzip'd backup's byte count. Fall back
    // to a UTF-8 byte count of the whole stdout (which is what the mock
    // dictionary's canned output gives) so audit metadata always has a
    // numeric backupSize even when running against `client-mock`.
    const sizeLine = result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l))
      .pop();
    const backupSize = sizeLine
      ? Number(sizeLine)
      : Buffer.byteLength(result.stdout, 'utf8');

    await recordAudit({
      userId: null,
      action: 'backup.completed',
      entityType: 'tenant',
      entityId: t.tenantId,
      metadata: {
        tenantId: t.tenantId,
        shortCode: t.shortCode,
        serverId: t.serverId,
        filename,
        backupSize,
      },
    });
    return {
      tenantId: t.tenantId,
      shortCode: t.shortCode,
      ok: true,
      filename,
      backupSize,
    };
  } catch (err) {
    // SSH connect/exec error path. Best-effort disconnect so we don't leak
    // a socket if connect succeeded but exec threw.
    try {
      await client.disconnect();
    } catch {
      /* already failed, ignore */
    }
    const msg = err instanceof Error ? err.message : String(err);
    await recordAudit({
      userId: null,
      action: 'backup.failed',
      entityType: 'tenant',
      entityId: t.tenantId,
      metadata: {
        tenantId: t.tenantId,
        shortCode: t.shortCode,
        serverId: t.serverId,
        filename,
        errorMessage: msg,
      },
    });
    return {
      tenantId: t.tenantId,
      shortCode: t.shortCode,
      ok: false,
      reason: msg,
    };
  }
}

export async function run(): Promise<{
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
  results: BackupResult[];
}> {
  // Inner-join servers so a tenant whose server row was deleted (orphan)
  // does NOT receive a backup attempt — there's no host to ssh into.
  // `server_id_ref` is nullable with `onDelete: 'set null'`, so this gate
  // is real (S3 servers are FK with ON DELETE SET NULL).
  const active = await db
    .select({
      tenantId: tenants.id,
      shortCode: tenants.shortCode,
      serverId: servers.id,
      host: servers.publicIp,
      port: servers.sshPort,
      username: servers.sshUser,
      privateKeyEncrypted: servers.sshPrivateKeyEncrypted,
    })
    .from(tenants)
    .innerJoin(servers, eq(tenants.serverIdRef, servers.id))
    .where(eq(tenants.status, 'active'));

  // Serial loop instead of Promise.all so a single tenant's SSH stall
  // can't block the audit row writes for tenants that completed first.
  // At fleet sizes ~20 (IMPL §1.PB3 max), serial latency budget is
  // ~20 × (mock=20ms or real=~2-3s) = 40s-60s, well within the V1.5
  // cron tick budget (5min). If we grow past 100 tenants we'll need
  // a small worker-pool here.
  const results: BackupResult[] = [];
  for (const t of active) {
    results.push(await backupOne(t));
  }

  const completed = results.filter((r) => r.ok && !r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;

  // eslint-disable-next-line no-console
  console.info('[cron/daily-backup] swept', {
    attempted: results.length,
    completed,
    failed,
    skipped,
  });

  return { attempted: results.length, completed, failed, skipped, results };
}

/**
 * Alias matching the naming convention used by other cron modules
 * (S9 / `runStuckRecovery`, S15 / `runContractExpiry`,
 * S16 / `runSchemaDriftDetector`).
 */
export const runDailyBackup = run;
