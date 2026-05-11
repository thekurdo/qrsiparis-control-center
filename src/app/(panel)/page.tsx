/**
 * Dashboard ("Genel Durum") — server component (Phase H9+).
 *
 * Renders four KPIs (active customers, onboarding, problem count, server
 * capacity), the server-health list, the active-deploys list, and a
 * placeholder for the cron-generated info notes that arrive in Phase H11.
 *
 * All DB reads are aggregated via `Promise.all` for a single round-trip's
 * worth of latency. Counts come back as `bigint` from PG `count()` so we
 * coerce with `Number(...)` (safe for these small cardinalities).
 */

import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import Link from 'next/link';

import { db } from '@/db/client';
import { deployments, servers, tenants } from '@/db/schema';

// ---------------------------------------------------------------------------
// Inline presentational helpers — kept local to keep the dashboard a single
// readable unit. Promote to /components/cc when reused elsewhere.
// ---------------------------------------------------------------------------

type KpiVariant = 'neutral' | 'warning' | 'danger';

function KpiCard({
  label,
  value,
  link,
  variant = 'neutral',
}: {
  label: string;
  value: string | number;
  link?: string;
  variant?: KpiVariant;
}) {
  const accent =
    variant === 'danger'
      ? 'border-red-500/40'
      : variant === 'warning'
        ? 'border-amber-500/40'
        : 'border-slate-700';
  const valueColor =
    variant === 'danger'
      ? 'text-red-300'
      : variant === 'warning'
        ? 'text-amber-300'
        : 'text-slate-100';

  const inner = (
    <div
      className={`bg-slate-800 border ${accent} rounded-lg p-5 transition-colors hover:bg-slate-800/70`}
    >
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
        {label}
      </div>
      <div className={`text-3xl font-semibold ${valueColor}`}>{value}</div>
    </div>
  );

  return link ? (
    <Link href={link} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
}

function HealthBadge({
  health,
  status,
}: {
  health: 'healthy' | 'degraded' | 'critical' | null;
  status: 'active' | 'maintenance' | 'decommissioned' | 'error';
}) {
  // Status overrides health when the operator has manually marked the server.
  if (status === 'maintenance') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-300">
        <span aria-hidden="true">⚠</span>
        <span className="text-xs">Bakım</span>
      </span>
    );
  }
  if (status === 'decommissioned' || status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-red-300">
        <span aria-hidden="true">⛔</span>
        <span className="text-xs">
          {status === 'decommissioned' ? 'Devre Dışı' : 'Hata'}
        </span>
      </span>
    );
  }
  if (health === 'critical') {
    return (
      <span className="inline-flex items-center gap-1 text-red-300">
        <span aria-hidden="true">⛔</span>
        <span className="text-xs">Kritik</span>
      </span>
    );
  }
  if (health === 'degraded') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-300">
        <span aria-hidden="true">⚠</span>
        <span className="text-xs">Düşük</span>
      </span>
    );
  }
  if (health === 'healthy') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-300">
        <span aria-hidden="true">●</span>
        <span className="text-xs">Sağlıklı</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-slate-400">
      <span aria-hidden="true">○</span>
      <span className="text-xs">Bilinmiyor</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
  const [
    activeTenantCount,
    onboardingCount,
    sorunluCount,
    allServers,
    activeDeployments,
  ] = await Promise.all([
    db
      .select({ c: count() })
      .from(tenants)
      .where(eq(tenants.status, 'active'))
      .then((r) => Number(r[0]?.c ?? 0)),
    db
      .select({ c: count() })
      .from(tenants)
      .where(eq(tenants.status, 'onboarding'))
      .then((r) => Number(r[0]?.c ?? 0)),
    db
      .select({ c: count() })
      .from(tenants)
      .where(eq(tenants.containerStatus, 'error'))
      .then((r) => Number(r[0]?.c ?? 0)),
    db.select().from(servers),
    db
      .select()
      .from(deployments)
      .where(inArray(deployments.status, ['pending', 'in_progress'] as const))
      .orderBy(desc(deployments.createdAt))
      .limit(10),
  ]);

  // Tenant occupancy per server (excludes cancelled tenants — they no longer
  // consume their slot). NULL server_id_ref tenants are also excluded.
  const tenantCountsByServer = await db
    .select({ serverId: tenants.serverIdRef, c: count() })
    .from(tenants)
    .where(
      and(sql`${tenants.serverIdRef} IS NOT NULL`, ne(tenants.status, 'cancelled')),
    )
    .groupBy(tenants.serverIdRef);
  const countMap = new Map(
    tenantCountsByServer.map((r) => [r.serverId, Number(r.c)]),
  );

  const totalCapacity = allServers.reduce(
    (sum, s) => sum + (s.maxTenantsTheoretical ?? 20),
    0,
  );
  const totalUsed = allServers.reduce(
    (sum, s) => sum + (countMap.get(s.id) ?? 0),
    0,
  );
  const capacityRatio = totalCapacity > 0 ? totalUsed / totalCapacity : 0;
  const capacityVariant: KpiVariant =
    capacityRatio > 0.85 ? 'warning' : 'neutral';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Genel Durum</h1>

      {/* KPI grid (4 cards) */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Aktif Müşteri"
          value={activeTenantCount}
          link="/musteriler?status=active"
        />
        <KpiCard
          label="Onboarding"
          value={onboardingCount}
          link="/musteriler?status=onboarding"
        />
        <KpiCard
          label="Sorunlu"
          value={sorunluCount}
          variant={sorunluCount > 0 ? 'danger' : 'neutral'}
          link="/musteriler"
        />
        <KpiCard
          label="Sunucu Kapasite"
          value={`${totalUsed}/${totalCapacity}`}
          variant={capacityVariant}
          link="/sunucular"
        />
      </div>

      {/* Server health */}
      <section>
        <h2 className="font-semibold mb-3">Sunucu Sağlığı</h2>
        <div className="bg-slate-800 rounded-lg overflow-hidden">
          {allServers.map((s) => (
            <Link
              key={s.id}
              href={`/sunucular/${s.id}`}
              className="block p-3 border-b border-slate-700 last:border-0 hover:bg-slate-700/50"
            >
              <div className="flex justify-between items-center gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <HealthBadge health={s.lastHealthStatus} status={s.status} />
                  <span className="font-mono text-sm">{s.name}</span>
                  <span className="text-slate-400 text-sm">
                    {countMap.get(s.id) ?? 0}/{s.maxTenantsTheoretical ?? 20}{' '}
                    müşteri
                  </span>
                </div>
                <span className="text-xs text-slate-500">
                  CPU {s.cpuUsagePct ?? '—'}% · RAM {s.ramUsagePct ?? '—'}% ·
                  Disk {s.diskUsagePct ?? '—'}%
                </span>
              </div>
            </Link>
          ))}
          {allServers.length === 0 && (
            <p className="p-3 text-sm text-slate-400">Henüz sunucu yok</p>
          )}
        </div>
      </section>

      {/* Active deploys */}
      <section>
        <h2 className="font-semibold mb-3">
          Aktif Deploy&apos;lar ({activeDeployments.length})
        </h2>
        <div className="bg-slate-800 rounded-lg overflow-hidden">
          {activeDeployments.map((d) => (
            <Link
              key={d.id}
              href={`/deployments/${d.id}`}
              className="block p-3 border-b border-slate-700 last:border-0 hover:bg-slate-700/50"
            >
              <div className="flex justify-between items-center">
                <div>
                  <span className="text-xs font-mono text-slate-400">
                    {d.deploymentType}
                  </span>
                  <span className="ml-3 font-mono text-xs text-slate-300">
                    {d.tenantId}
                  </span>
                </div>
                <span className="text-xs">
                  {d.status === 'pending'
                    ? '⏸ Beklemede'
                    : '⏳ Devam ediyor'}
                </span>
              </div>
            </Link>
          ))}
          {activeDeployments.length === 0 && (
            <p className="p-3 text-sm text-slate-400">Aktif deploy yok</p>
          )}
        </div>
      </section>

      {/* Info notes (Phase H11 hook) */}
      <section>
        <h2 className="font-semibold mb-3">Bilgilendirme Notları</h2>
        <div className="bg-slate-800 rounded-lg p-4 text-sm text-slate-400">
          <p>
            Cron tabanlı bilgilendirme notları (disk uyarıları, sözleşme
            bitişleri vb.) Phase H11&apos;de eklenecek.
          </p>
        </div>
      </section>
    </div>
  );
}
