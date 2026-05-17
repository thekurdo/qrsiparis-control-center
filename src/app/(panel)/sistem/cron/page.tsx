/**
 * /sistem/cron — cron job durumu sayfası (Phase H11).
 *
 * V1 kapsamı: cron job'ları stub olarak listelenir. Her job için
 * gerçek `run()` fonksiyonu `src/lib/crons/<job>/index.ts` altında
 * mevcuttur fakat scheduler V1.5'te (node-cron veya BullMQ repeatable
 * jobs) eklenecektir. UI bu yüzden son çalıştırma / sonraki çalıştırma
 * verilerini göstermez ve manuel tetikleme / log görüntüleme butonları
 * disable durumdadır.
 *
 * Admin-only: operator rolündeki kullanıcılar `requireOperatorAuth`
 * tarafından `/` sayfasına yönlendirilir.
 */

import { requireOperatorAuth } from '@/lib/auth/middleware';

const CRON_JOBS = [
  {
    id: 'tenant-health-check',
    name: 'Tenant Health Check',
    schedule: 'Her 5 dakika',
    description: 'Tüm aktif tenant container sağlığını kontrol eder',
  },
  {
    id: 'server-resource-monitor',
    name: 'Server Resource Monitor',
    schedule: 'Her 1 dakika',
    description: 'CPU/RAM/Disk kullanımı toplar',
  },
  {
    id: 'contract-expiry-warning',
    name: 'Sözleşme Bitişi Uyarısı',
    schedule: 'Günlük 09:00',
    description: 'Sözleşmesi 7 gün içinde bitecek tenantları işaretler',
  },
  {
    id: 'daily-backup',
    name: 'Daily Backup',
    schedule: 'Günlük 03:00',
    description: 'Tüm tenant SQLite dosyalarının yedeğini alır',
  },
  {
    id: 'deployment-stuck-recovery',
    name: 'Stuck Deployment Recovery',
    schedule: 'Her 1 dakika',
    description:
      '30dk üzerinde "in_progress" kalan deployları failed olarak işaretler',
  },
  {
    id: 'tenant-schema-drift-detector',
    name: 'Schema Drift Detector',
    schedule: 'Günlük',
    description:
      'Paused tenantlar resume edildiğinde schema_version uyumsuzluğunu tespit eder',
  },
] as const;

export default async function CronPage() {
  await requireOperatorAuth(['admin']);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-100">Cron Jobs</h1>
        <p className="mt-1 text-slate-400">Sistem zamanlanmış görevleri</p>
      </header>

      <div className="rounded-lg border border-amber-800 bg-amber-900/20 p-4 text-sm text-amber-300">
        ⚠ V1: Cron job&apos;ları stub olarak tanımlı. Actual scheduler
        V1.5&apos;te eklenecek (node-cron veya BullMQ repeatable jobs).
      </div>

      <div className="overflow-hidden rounded-lg bg-slate-800">
        <table className="w-full text-sm text-slate-100">
          <thead className="bg-slate-700">
            <tr>
              {['Job', 'Schedule', 'Açıklama', 'Aksiyonlar'].map((h) => (
                <th key={h} className="px-4 py-3 text-left">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CRON_JOBS.map((job) => (
              <tr key={job.id} className="border-t border-slate-700">
                <td className="px-4 py-3 font-medium">{job.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-300">
                  {job.schedule}
                </td>
                <td className="px-4 py-3 text-sm text-slate-400">
                  {job.description}
                </td>
                <td className="px-4 py-3">
                  <button
                    disabled
                    className="cursor-not-allowed rounded bg-slate-700 px-3 py-1 text-xs opacity-50"
                  >
                    Manuel Çalıştır (V1.5)
                  </button>
                  <button
                    disabled
                    className="ml-2 cursor-not-allowed rounded bg-slate-700 px-3 py-1 text-xs opacity-50"
                  >
                    Logları Gör (V1.5)
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
