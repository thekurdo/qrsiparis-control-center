/**
 * /deployments — deploy list with status / type / tenant filters (Phase H8).
 *
 * Server component. Lists the latest 100 deployments across the fleet with
 * filterable status / type / tenant chips. Each row links to
 * `/deployments/[id]` for the detail view + live SSE log.
 *
 * Why limit 100: the deployments table grows monotonically (every operator
 * action stamps a row); pagination ships in V1.5. For now an operator
 * realistically only cares about recent activity — anything older is
 * inspected via the audit log.
 *
 * Filters compose multiplicatively: `?status=failed&type=initial` shows
 * only initial deploys that failed. The query is built dynamically so an
 * unfiltered visit still returns the most recent 100 across all types.
 */

import type { Route } from 'next';
import Link from 'next/link';
import { and, desc, eq, type SQL } from 'drizzle-orm';

import { db } from '@/db/client';
import { deployments, servers, tenants } from '@/db/schema';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import {
  DeployStatusPill,
  type DeployStatus,
} from '@/components/StatusPill';
import type { DeploymentType } from '@/types/db';

type SearchParams = {
  status?: string;
  type?: string;
  tenantId?: string;
};

const DEPLOY_STATUS_VALUES: ReadonlyArray<DeployStatus> = [
  'pending',
  'in_progress',
  'success',
  'failed',
  'rolled_back',
];

const DEPLOY_TYPE_VALUES: ReadonlyArray<DeploymentType> = [
  'initial',
  'config_update',
  'app_update',
  'redeploy',
  'rollback',
];

const STATUS_FILTERS: Array<{ value: DeployStatus | 'all'; label: string }> = [
  { value: 'all', label: 'Hepsi' },
  { value: 'pending', label: 'Beklemede' },
  { value: 'in_progress', label: 'Devam Ediyor' },
  { value: 'success', label: 'Başarılı' },
  { value: 'failed', label: 'Başarısız' },
  { value: 'rolled_back', label: 'Geri Alındı' },
];

const TYPE_FILTERS: Array<{ value: DeploymentType | 'all'; label: string }> = [
  { value: 'all', label: 'Tüm Tipler' },
  { value: 'initial', label: 'Initial' },
  { value: 'config_update', label: 'Config Update' },
  { value: 'app_update', label: 'App Update' },
  { value: 'redeploy', label: 'Redeploy' },
  { value: 'rollback', label: 'Rollback' },
];

function isStatus(v: string | undefined): v is DeployStatus {
  return v !== undefined && (DEPLOY_STATUS_VALUES as ReadonlyArray<string>).includes(v);
}
function isType(v: string | undefined): v is DeploymentType {
  return v !== undefined && (DEPLOY_TYPE_VALUES as ReadonlyArray<string>).includes(v);
}

export default async function DeploymentsListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireOperatorAuth(['admin', 'operator']);
  const sp = await searchParams;

  const filters: SQL[] = [];
  if (isStatus(sp.status)) filters.push(eq(deployments.status, sp.status));
  if (isType(sp.type)) filters.push(eq(deployments.deploymentType, sp.type));
  if (sp.tenantId) filters.push(eq(deployments.tenantId, sp.tenantId));

  const whereClause =
    filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);

  const rows = await db
    .select({
      id: deployments.id,
      tenantId: deployments.tenantId,
      tenantName: tenants.restaurantName,
      tenantShortCode: tenants.shortCode,
      serverName: servers.name,
      type: deployments.deploymentType,
      status: deployments.status,
      appVersion: deployments.appVersion,
      startedAt: deployments.startedAt,
      completedAt: deployments.completedAt,
      durationSeconds: deployments.durationSeconds,
      createdAt: deployments.createdAt,
      errorCode: deployments.errorCode,
    })
    .from(deployments)
    .leftJoin(tenants, eq(deployments.tenantId, tenants.id))
    .leftJoin(servers, eq(deployments.serverId, servers.id))
    .where(whereClause)
    .orderBy(desc(deployments.createdAt))
    .limit(100);

  const activeStatus: DeployStatus | 'all' = isStatus(sp.status) ? sp.status : 'all';
  const activeType: DeploymentType | 'all' = isType(sp.type) ? sp.type : 'all';

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Deployments</h1>
          <p className="text-sm text-slate-400 mt-1">
            Son 100 kayıt · Toplam {rows.length} sonuç
          </p>
        </div>
      </header>

      <FilterChips activeStatus={activeStatus} activeType={activeType} sp={sp} />

      <div className="bg-slate-800 rounded-lg overflow-hidden border border-slate-700">
        <table className="w-full text-sm text-slate-100">
          <thead className="bg-slate-700/60 text-xs uppercase tracking-wide text-slate-300">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">Tarih</th>
              <th className="px-4 py-3 text-left font-semibold">Müşteri</th>
              <th className="px-4 py-3 text-left font-semibold">Sunucu</th>
              <th className="px-4 py-3 text-left font-semibold">Tip</th>
              <th className="px-4 py-3 text-left font-semibold">Versiyon</th>
              <th className="px-4 py-3 text-right font-semibold">Süre</th>
              <th className="px-4 py-3 text-left font-semibold">Durum</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr
                key={d.id}
                className="border-t border-slate-700 hover:bg-slate-700/40"
              >
                <td className="px-4 py-3 text-slate-300 whitespace-nowrap">
                  {d.createdAt
                    ? new Date(d.createdAt).toLocaleString('tr-TR')
                    : '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="text-slate-200">{d.tenantName ?? '—'}</div>
                  <div className="text-xs text-slate-500 font-mono">
                    {d.tenantShortCode ?? ''}
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-300">{d.serverName ?? '—'}</td>
                <td className="px-4 py-3 text-xs font-mono text-slate-300">
                  {d.type}
                </td>
                <td className="px-4 py-3 text-xs font-mono text-slate-300">
                  {d.appVersion ?? '—'}
                </td>
                <td className="px-4 py-3 text-xs text-right tabular-nums text-slate-300">
                  {d.durationSeconds !== null && d.durationSeconds !== undefined
                    ? `${d.durationSeconds}s`
                    : '—'}
                </td>
                <td className="px-4 py-3">
                  <DeployStatusPill status={d.status} />
                  {d.status === 'failed' && d.errorCode ? (
                    <div className="text-[10px] uppercase tracking-wide text-red-300 mt-1 font-mono">
                      {d.errorCode}
                    </div>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/deployments/${d.id}`}
                    className="text-blue-400 hover:text-blue-300 hover:underline text-sm"
                  >
                    Detay
                  </Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-12 text-center text-sm text-slate-400"
                >
                  Bu filtrelerle eşleşen deploy yok.
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
 * Filter chip strip — two rows of pills (status + type). Switching one
 * filter preserves the other plus any tenantId in the URL via a query-
 * string builder. `all` removes the corresponding param.
 */
function FilterChips({
  activeStatus,
  activeType,
  sp,
}: {
  activeStatus: DeployStatus | 'all';
  activeType: DeploymentType | 'all';
  sp: SearchParams;
}) {
  function buildHref(
    next: { status?: DeployStatus | 'all'; type?: DeploymentType | 'all' },
  ): string {
    const params = new URLSearchParams();
    const status = next.status ?? activeStatus;
    const type = next.type ?? activeType;
    if (status !== 'all') params.set('status', status);
    if (type !== 'all') params.set('type', type);
    if (sp.tenantId) params.set('tenantId', sp.tenantId);
    const qs = params.toString();
    return qs.length > 0 ? `/deployments?${qs}` : '/deployments';
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        {STATUS_FILTERS.map((f) => {
          const isActive = activeStatus === f.value;
          return (
            <Link
              key={f.value}
              href={buildHref({ status: f.value }) as Route}
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
      <div className="flex gap-2 flex-wrap">
        {TYPE_FILTERS.map((f) => {
          const isActive = activeType === f.value;
          return (
            <Link
              key={f.value}
              href={buildHref({ type: f.value }) as Route}
              className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${
                isActive
                  ? 'bg-blue-700/60 text-blue-100 border border-blue-600'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700 border border-slate-700'
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
