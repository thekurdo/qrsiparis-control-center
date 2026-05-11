/**
 * /sunucular — VPS list with capacity + health (Phase H4).
 *
 * Server component. Lists every VPS in the fleet with:
 *   - Health badge (healthy / degraded / critical / maintenance / decommissioned)
 *   - Capacity bar: tenants_on_server / max_tenants_theoretical (default 20)
 *   - CPU / RAM / Disk usage bars (color thresholds 60% / 80% per IMPL §1.PB3)
 *   - Uptime + last health-check timestamp
 *
 * Tenant counts are derived from the `tenants` table with a single GROUP BY
 * query (excluding `cancelled` rows) so the list scales as fleet grows.
 */
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { db } from '@/db/client';
import { servers, tenants } from '@/db/schema';
import { sql } from 'drizzle-orm';
import Link from 'next/link';

export default async function SunucularPage() {
  await requireOperatorAuth(['admin', 'operator']);

  const list = await db
    .select({
      id: servers.id,
      name: servers.name,
      publicIp: servers.publicIp,
      publicHostname: servers.publicHostname,
      status: servers.status,
      lastHealthStatus: servers.lastHealthStatus,
      lastHealthCheckAt: servers.lastHealthCheckAt,
      cpuUsagePct: servers.cpuUsagePct,
      ramUsagePct: servers.ramUsagePct,
      diskUsagePct: servers.diskUsagePct,
      uptimeDays: servers.uptimeDays,
      maxTenantsTheoretical: servers.maxTenantsTheoretical,
      coolifyUrl: servers.coolifyUrl,
    })
    .from(servers);

  const counts = await db
    .select({ serverId: tenants.serverIdRef, count: sql<number>`COUNT(*)` })
    .from(tenants)
    .where(sql`${tenants.serverIdRef} IS NOT NULL AND ${tenants.status} != 'cancelled'`)
    .groupBy(tenants.serverIdRef);

  const countMap = new Map<string, number>(
    counts
      .filter((c): c is { serverId: string; count: number } => c.serverId !== null)
      .map((c) => [c.serverId, Number(c.count)]),
  );

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-100">Sunucular</h1>
        <Link
          href="/sunucular/yeni"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium"
        >
          + Yeni Sunucu
        </Link>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {list.map((s) => {
          const tenantCount = countMap.get(s.id) ?? 0;
          const cap = s.maxTenantsTheoretical ?? 20;
          const capRatio = cap > 0 ? (tenantCount / cap) * 100 : 0;
          return (
            <Link
              key={s.id}
              href={`/sunucular/${s.id}`}
              className="bg-slate-800 hover:bg-slate-700/80 rounded-lg p-5 transition-colors block"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-100">{s.name}</h3>
                  <p className="text-xs text-slate-400 font-mono mt-1">
                    {s.publicIp}
                    {s.publicHostname ? ` · ${s.publicHostname}` : ''}
                  </p>
                </div>
                <HealthBadge health={s.lastHealthStatus} status={s.status} />
              </div>

              {/* Capacity bar — green <60%, yellow 60-80%, red >=80% (IMPL §1.PB3) */}
              <div className="mb-3">
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span>Müşteri Kapasitesi</span>
                  <span className="font-medium">
                    {tenantCount}/{cap}
                  </span>
                </div>
                <div className="h-2 bg-slate-700 rounded overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      capRatio < 60
                        ? 'bg-emerald-500'
                        : capRatio < 80
                          ? 'bg-amber-500'
                          : 'bg-red-500'
                    }`}
                    style={{ width: `${Math.min(capRatio, 100)}%` }}
                  />
                </div>
              </div>

              {/* CPU/RAM/Disk bars */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <ResourceBar label="CPU" pct={s.cpuUsagePct} />
                <ResourceBar label="RAM" pct={s.ramUsagePct} />
                <ResourceBar label="Disk" pct={s.diskUsagePct} />
              </div>

              <div className="flex justify-between text-xs text-slate-500 mt-3">
                <span>Uptime: {s.uptimeDays ?? '—'}g</span>
                <span>
                  {s.lastHealthCheckAt
                    ? `Son check: ${new Date(s.lastHealthCheckAt).toLocaleTimeString('tr-TR')}`
                    : 'Hiç check yapılmadı'}
                </span>
              </div>
            </Link>
          );
        })}
        {list.length === 0 && (
          <p className="text-slate-400 col-span-full">Henüz sunucu eklenmedi</p>
        )}
      </div>
    </div>
  );
}

function HealthBadge({
  health,
  status,
}: {
  health: string | null;
  status: string;
}) {
  if (status === 'maintenance') {
    return (
      <span className="px-2 py-0.5 bg-slate-700 text-slate-300 rounded text-xs">
        Bakımda
      </span>
    );
  }
  if (status === 'decommissioned') {
    return (
      <span className="px-2 py-0.5 bg-slate-700 text-slate-500 rounded text-xs">
        Kullanım Dışı
      </span>
    );
  }
  if (health === 'critical') {
    return (
      <span className="px-2 py-0.5 bg-red-900/40 text-red-300 rounded text-xs">
        ⛔ Kritik
      </span>
    );
  }
  if (health === 'degraded') {
    return (
      <span className="px-2 py-0.5 bg-amber-900/40 text-amber-300 rounded text-xs">
        ⚠ Düşük
      </span>
    );
  }
  if (health === 'healthy') {
    return (
      <span className="px-2 py-0.5 bg-emerald-900/40 text-emerald-300 rounded text-xs">
        ● Sağlıklı
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 bg-slate-700 text-slate-400 rounded text-xs">—</span>
  );
}

function ResourceBar({ label, pct }: { label: string; pct: number | null }) {
  const v = pct ?? 0;
  const color = v < 60 ? 'bg-emerald-500' : v < 80 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div>
      <div className="flex justify-between text-slate-400 mb-0.5">
        <span>{label}</span>
        <span className="tabular-nums">{pct !== null ? `${pct}%` : '—'}</span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded overflow-hidden">
        <div className={`h-full transition-all ${color}`} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}
