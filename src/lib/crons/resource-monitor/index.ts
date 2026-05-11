/**
 * Server Resource Monitor cron job (Phase H11 stub).
 *
 * Schedule (V1.5): her 1 dakika.
 *
 * Mantık (V1.5 hedefi):
 *   1. status='active' tüm sunucuları çek
 *   2. Her biri için SSH ile `top -bn1 | head -n5` + `df -h /` çalıştır
 *   3. CPU%, RAM%, Disk%, uptime'ı parse et
 *   4. servers tablosundaki ilgili kolonları güncelle
 *
 * V1 stub: SSH client (henüz lib/ssh/* mevcut değil) ve metrics parser
 * V1.5'te yazılacak. Bu fonksiyon şimdilik server listesini çekiyor ve
 * her sunucu için boş/0 metrik logluyor; UI tarafında "veri yok" durumu
 * mevcut kolonların NULL'ı ile zaten karşılanıyor.
 *
 * V1.5: lib/ssh/exec.ts üzerinden komut çalıştırılacak; çıktı parse'lı
 * şekilde Drizzle update'e dönüştürülecek.
 */

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { servers } from '@/db/schema';

interface ResourceSnapshot {
  serverId: string;
  cpuUsagePct: number | null;
  ramUsagePct: number | null;
  diskUsagePct: number | null;
  uptimeDays: number | null;
}

async function collectMetrics(serverId: string): Promise<ResourceSnapshot> {
  // V1.5: const out = await sshExec(serverId, 'top -bn1 | head -n5 && df -h /');
  // const { cpu, ram, disk, uptime } = parseTopAndDf(out);
  return {
    serverId,
    cpuUsagePct: null,
    ramUsagePct: null,
    diskUsagePct: null,
    uptimeDays: null,
  };
}

export async function run(): Promise<{ collected: number }> {
  const active = await db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.status, 'active'));

  const snapshots = await Promise.all(active.map((s) => collectMetrics(s.id)));

  // V1.5: snapshots.forEach -> db.update(servers).set({ cpu_usage_pct, ... })
  // V1 stub: sadece çağrı yapıldığını logla.
  // eslint-disable-next-line no-console
  console.info('[cron/resource-monitor] collected', {
    serverCount: snapshots.length,
    note: 'SSH metric collection V1.5 — values not persisted yet',
  });

  return { collected: snapshots.length };
}
