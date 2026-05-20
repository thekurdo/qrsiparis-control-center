/**
 * /musteriler — tenant list (filterable + searchable).
 *
 * Server component. Auth gate at the top (admin + operator can both view).
 *
 * Filters:
 *   - status   (?status=onboarding|active|paused|cancelled)
 *   - tier     (?tier=baslangic|standart|profesyonel)
 *   - serverId (?serverId=<uuid>)
 *   - q        (?q=...)  case-insensitive ILIKE on short_code, restaurant_name, domain
 *
 * The query is built dynamically: only the predicates that have a value
 * actually become part of the WHERE clause, so an unfiltered visit just
 * orders by `created_at DESC`.
 */

import type { Route } from 'next';
import Link from 'next/link';
import { and, desc, eq, ilike, or, type SQL } from 'drizzle-orm';

import { db } from '@/db/client';
import { tenants, servers } from '@/db/schema';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import {
  StatusPill,
  ContainerStatusPill,
  TierBadge,
  type TenantStatus,
  type Tier,
} from '@/components/StatusPill';
import { formatTl } from '@/lib/utils/format-tl';

type SearchParams = {
  status?: string;
  tier?: string;
  q?: string;
  serverId?: string;
};

// Status filter chips — order matches the natural lifecycle.
const STATUS_FILTERS: Array<{ value: TenantStatus | 'all'; label: string }> = [
  { value: 'all', label: 'Hepsi' },
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'active', label: 'Aktif' },
  { value: 'paused', label: 'Duraklatıldı' },
  { value: 'cancelled', label: 'İptal' },
];

// Type guards keep narrow string-literal columns happy without casting.
const TENANT_STATUS_VALUES: ReadonlyArray<TenantStatus> = [
  'onboarding',
  'active',
  'paused',
  'cancelled',
];
const TIER_VALUES: ReadonlyArray<Tier> = ['baslangic', 'standart', 'profesyonel'];

function isStatus(v: string | undefined): v is TenantStatus {
  return v !== undefined && (TENANT_STATUS_VALUES as ReadonlyArray<string>).includes(v);
}
function isTier(v: string | undefined): v is Tier {
  return v !== undefined && (TIER_VALUES as ReadonlyArray<string>).includes(v);
}

export default async function MusterilerPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireOperatorAuth(['admin', 'operator']);
  const sp = await searchParams;

  const filters: SQL[] = [];
  if (isStatus(sp.status)) filters.push(eq(tenants.status, sp.status));
  if (isTier(sp.tier)) filters.push(eq(tenants.tier, sp.tier));
  if (sp.serverId) filters.push(eq(tenants.serverIdRef, sp.serverId));
  if (sp.q && sp.q.trim().length > 0) {
    const like = `%${sp.q.trim()}%`;
    const qFilter = or(
      ilike(tenants.shortCode, like),
      ilike(tenants.restaurantName, like),
      ilike(tenants.domain, like),
    );
    if (qFilter) filters.push(qFilter);
  }

  const whereClause =
    filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);

  const rows = await db
    .select({
      id: tenants.id,
      shortCode: tenants.shortCode,
      restaurantName: tenants.restaurantName,
      tier: tenants.tier,
      status: tenants.status,
      containerStatus: tenants.containerStatus,
      monthlyFeeKurus: tenants.monthlyFeeKurus,
      domain: tenants.domain,
      serverName: servers.name,
      contractEndDate: tenants.contractEndDate,
    })
    .from(tenants)
    .leftJoin(servers, eq(tenants.serverIdRef, servers.id))
    .where(whereClause)
    .orderBy(desc(tenants.createdAt));

  const activeStatus = isStatus(sp.status) ? sp.status : 'all';

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Müşteriler</h1>
          <p className="text-sm text-slate-400 mt-1">
            Toplam {rows.length} kayıt
          </p>
        </div>
        <Link
          href="/musteriler/yeni"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium text-sm"
        >
          + Yeni Müşteri
        </Link>
      </header>

      {/* Filter chips — preserves q/tier/serverId via hidden links */}
      <FilterChips currentStatus={activeStatus} sp={sp} />

      {/* Search box */}
      <form className="flex gap-2" method="get" action="/musteriler">
        {sp.tier ? <input type="hidden" name="tier" value={sp.tier} /> : null}
        {sp.status ? <input type="hidden" name="status" value={sp.status} /> : null}
        {sp.serverId ? (
          <input type="hidden" name="serverId" value={sp.serverId} />
        ) : null}
        <input
          name="q"
          defaultValue={sp.q ?? ''}
          placeholder="Slug / restoran adı / domain ara..."
          className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
        />
        <button
          type="submit"
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm text-slate-100"
        >
          Ara
        </button>
      </form>

      <div className="bg-slate-800 rounded-lg overflow-hidden border border-slate-700">
        <table className="w-full text-sm text-slate-100">
          <thead className="bg-slate-700/60 text-xs uppercase tracking-wide text-slate-300">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">Slug</th>
              <th className="px-4 py-3 text-left font-semibold">Restoran</th>
              <th className="px-4 py-3 text-left font-semibold">Tier</th>
              <th className="px-4 py-3 text-left font-semibold">Sunucu</th>
              <th className="px-4 py-3 text-left font-semibold">Durum</th>
              <th className="px-4 py-3 text-left font-semibold">Container</th>
              <th className="px-4 py-3 text-right font-semibold">Aylık</th>
              <th className="px-4 py-3 text-left font-semibold">Sözleşme Bitiş</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className="border-t border-slate-700 hover:bg-slate-700/40"
              >
                <td className="px-4 py-3 font-mono text-xs text-slate-200">
                  {row.shortCode}
                </td>
                <td className="px-4 py-3">
                  <div>{row.restaurantName}</div>
                  <div className="text-xs text-slate-500">{row.domain}</div>
                </td>
                <td className="px-4 py-3">
                  <TierBadge tier={row.tier} />
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {row.serverName ?? '—'}
                </td>
                <td className="px-4 py-3">
                  <StatusPill status={row.status} />
                </td>
                <td className="px-4 py-3">
                  <ContainerStatusPill status={row.containerStatus} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatTl(row.monthlyFeeKurus)}
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {row.contractEndDate
                    ? new Date(row.contractEndDate).toLocaleDateString('tr-TR')
                    : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/musteriler/${row.id}`}
                    className="text-blue-400 hover:text-blue-300 hover:underline text-sm"
                  >
                    Görüntüle
                  </Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-12 text-center text-sm text-slate-400"
                >
                  Bu filtrelerle eşleşen müşteri yok.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline helpers
// ---------------------------------------------------------------------------

/**
 * Status filter chips. Switching status preserves all other filters in the
 * URL via a custom query-string builder. `all` removes the `status` param.
 */
function FilterChips({
  currentStatus,
  sp,
}: {
  currentStatus: TenantStatus | 'all';
  sp: SearchParams;
}) {
  const buildHref = (status: TenantStatus | 'all'): string => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (sp.tier) params.set('tier', sp.tier);
    if (sp.serverId) params.set('serverId', sp.serverId);
    if (sp.q) params.set('q', sp.q);
    const qs = params.toString();
    return qs.length > 0 ? `/musteriler?${qs}` : '/musteriler';
  };

  return (
    <div className="flex gap-2 flex-wrap">
      {STATUS_FILTERS.map((f) => {
        const isActive = currentStatus === f.value;
        return (
          <Link
            key={f.value}
            href={buildHref(f.value) as Route}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              isActive
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {f.label}
          </Link>
        );
      })}
    </div>
  );
}
