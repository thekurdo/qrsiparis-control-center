/**
 * /sunucular/[id] — server detail with resource cards + tenant roster (Phase H4).
 *
 * Server component. Pulls the server row + every non-cancelled tenant placed
 * on it. Renders:
 *   - Header with public IP/hostname + Coolify link + V1.5 stub buttons.
 *   - Capacity widget (tenants / max_tenants_theoretical) with threshold bar.
 *   - CPU / RAM / Disk resource cards. Disk card emits warning text once
 *     usage reaches 75% (IMPL §1.PB3 disk-warning band).
 *   - Tenant roster linking to /musteriler/[id] for drill-down.
 *   - Coolify Senkronizasyonu placeholder — live sync arrives in Phase H7.
 */
import { db } from '@/db/client';
import { servers, tenants } from '@/db/schema';
import { eq, and, ne } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireOperatorAuth } from '@/lib/auth/middleware';

export default async function SunucuDetayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireOperatorAuth(['admin', 'operator']);

  const server = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1)
    .then((r) => r[0]);
  if (!server) notFound();

  const onThisServer = await db
    .select({
      id: tenants.id,
      shortCode: tenants.shortCode,
      restaurantName: tenants.restaurantName,
      status: tenants.status,
      containerStatus: tenants.containerStatus,
    })
    .from(tenants)
    .where(and(eq(tenants.serverIdRef, id), ne(tenants.status, 'cancelled')));

  const cap = server.maxTenantsTheoretical ?? 20;
  const occ = onThisServer.length;
  const capPct = cap > 0 ? (occ / cap) * 100 : 0;

  return (
    <div className="space-y-6">
      <Link href="/sunucular" className="text-blue-400 text-sm hover:underline">
        ← Sunucular
      </Link>

      <header>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">{server.name}</h1>
            <p className="text-sm text-slate-400 font-mono mt-1">
              {server.publicIp}
              {server.publicHostname ? ` · ${server.publicHostname}` : ''}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Uptime: {server.uptimeDays ?? '—'}g · Durum:{' '}
              <span className="text-slate-300">{server.status}</span>
            </p>
          </div>
          <div className="flex gap-2">
            <a
              href={server.coolifyUrl ?? '#'}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm text-slate-200"
            >
              Coolify
            </a>
            <button
              disabled
              className="px-3 py-2 bg-slate-700 opacity-50 rounded text-sm cursor-not-allowed text-slate-200"
            >
              Sağlık Testi (V1.5)
            </button>
            <button
              disabled
              className="px-3 py-2 bg-amber-700 opacity-50 rounded text-sm cursor-not-allowed text-amber-100"
            >
              Bakım (V1.5)
            </button>
          </div>
        </div>
      </header>

      {/* Stats grid */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="bg-slate-800 rounded-lg p-4">
          <p className="text-sm text-slate-400 mb-2">Müşteri Sayısı</p>
          <p className="text-3xl font-semibold text-slate-100 tabular-nums">
            {occ}
            <span className="text-base text-slate-500">/{cap}</span>
          </p>
          <div className="mt-2 h-1.5 bg-slate-700 rounded overflow-hidden">
            <div
              className={`h-full ${
                capPct < 60
                  ? 'bg-emerald-500'
                  : capPct < 80
                    ? 'bg-amber-500'
                    : 'bg-red-500'
              }`}
              style={{ width: `${Math.min(capPct, 100)}%` }}
            />
          </div>
        </div>

        <ResourceCard label="CPU Kullanımı" pct={server.cpuUsagePct} />
        <ResourceCard label="RAM Kullanımı" pct={server.ramUsagePct} />
        <ResourceCard
          label="Disk Kullanımı"
          pct={server.diskUsagePct}
          note={
            server.diskUsagePct !== null && server.diskUsagePct >= 75
              ? 'Disk uyarı eşiği aşıldı'
              : undefined
          }
        />
      </div>

      {/* Tenant list on this server */}
      <div className="bg-slate-800 rounded-lg p-4">
        <h2 className="font-semibold text-slate-100 mb-3">
          Bu sunucuda barınan müşteriler ({onThisServer.length})
        </h2>
        <div className="space-y-2">
          {onThisServer.map((t) => (
            <Link
              key={t.id}
              href={`/musteriler/${t.id}`}
              className="flex justify-between items-center p-3 bg-slate-700/50 hover:bg-slate-700 rounded transition-colors"
            >
              <div>
                <span className="font-mono text-xs text-slate-400">{t.shortCode}</span>
                <span className="ml-3 text-slate-200">{t.restaurantName}</span>
              </div>
              <span className="text-xs text-slate-400">
                {t.status} · {t.containerStatus}
              </span>
            </Link>
          ))}
          {onThisServer.length === 0 && (
            <p className="text-sm text-slate-400">Henüz müşteri yok</p>
          )}
        </div>
      </div>

      {/* Coolify sync widget */}
      <div className="bg-slate-800 rounded-lg p-4">
        <h2 className="font-semibold text-slate-100 mb-2">Coolify Senkronizasyonu</h2>
        <p className="text-sm text-slate-400">
          DB tenant sayısı: {occ}. Coolify uygulamaları:{' '}
          <span className="text-slate-500">
            (Phase H7&apos;de canlı senkronizasyon eklenecek)
          </span>
        </p>
      </div>
    </div>
  );
}

function ResourceCard({
  label,
  pct,
  note,
}: {
  label: string;
  pct: number | null;
  note?: string;
}) {
  const v = pct ?? 0;
  const color = v < 60 ? 'bg-emerald-500' : v < 80 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="bg-slate-800 rounded-lg p-4">
      <p className="text-sm text-slate-400 mb-2">{label}</p>
      <p className="text-3xl font-semibold text-slate-100 tabular-nums">
        {pct !== null ? `${pct}%` : '—'}
      </p>
      <div className="mt-2 h-1.5 bg-slate-700 rounded overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${v}%` }} />
      </div>
      {note && <p className="text-xs text-amber-400 mt-2">{note}</p>}
    </div>
  );
}
