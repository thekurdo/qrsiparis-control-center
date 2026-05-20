/**
 * /sistem/audit — operator audit log viewer (Phase H11 / S5).
 *
 * Server component. Renders an append-only table of `audit_log` rows with
 * URL-driven filters and offset/limit pagination. The table is read-only by
 * design — the `audit_log` table has an immutable DB trigger
 * (`tr_audit_log_immutable` in src/db/schema.ts), so there is intentionally
 * NO edit/delete UI on this page. S11 (audit immutability) will assert
 * that the route surfaces NO mutation controls; matches S11's contract by
 * construction here.
 *
 * Filter dimensions (all composable; URL is the source of truth):
 *   - actor      (audit_log.user_id)            — `?actor=<uuid>`
 *   - action     (audit_log.action)             — `?action=<dotted-or-snake>`
 *   - entityType (audit_log.entity_type)        — `?entityType=<string>`
 *   - dateFrom   (audit_log.created_at >= date) — `?dateFrom=YYYY-MM-DD`
 *   - dateTo     (audit_log.created_at <  date+1) — `?dateTo=YYYY-MM-DD`
 *   - page       (1-indexed)                    — `?page=2`
 *
 * Naming-convention discovery from S2 / S4 / S14:
 *   Two patterns coexist in `audit_log.action`:
 *     - dotted   : `operator_user.created`, `operator_user.updated`,
 *                  `operator_user.deleted`, `tenant.created`,
 *                  `deployment.triggered`, `deployment.failed`,
 *                  `deployment.stuck_recovered`, `server.updated` (S5).
 *     - snake_case: `operator_role_changed`, `backup_code_used`, `2fa_enabled`.
 *   The action filter accepts either — we pre-populate the dropdown from the
 *   set of distinct values currently in the DB so the operator always sees
 *   what's actually queryable without us hard-coding the union.
 *
 * Pagination:
 *   - PAGE_SIZE = 25 rows per page (small enough to scan; matches the
 *     deploy list size budget).
 *   - "Daha Fazla" / "Önceki" links increment / decrement the `page` param
 *     and preserve every other filter.
 *
 * Adjacency notes:
 *   - S11 (audit immutability): this page intentionally exposes ZERO mutation
 *     UI. Adding a Sil / Düzenle button here would break the audit contract.
 *   - S19 (backup cron): the daily-backup job writes audit rows
 *     `backup.completed` / `backup.failed`. Those names will show up in
 *     the action dropdown automatically (we read distinct values from DB).
 */

import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { Route } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { auditLog, operatorUsers } from '@/db/schema';
import { requireOperatorAuth } from '@/lib/auth/middleware';

const PAGE_SIZE = 25;

type SearchParams = {
  actor?: string;
  action?: string;
  entityType?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: string;
};

/**
 * Lenient UUID gate. Used to discard `?actor=garbage` without hitting the
 * DB where Postgres would throw "invalid input syntax for type uuid".
 */
function isUuid(s: string | undefined): s is string {
  if (!s) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
}

/** YYYY-MM-DD only. Anything else gets dropped silently. */
function parseDateOnly(s: string | undefined): Date | null {
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Add N days to a date (UTC, no DST surprises). */
function addDays(d: Date, n: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireOperatorAuth(['admin']);
  const sp = await searchParams;

  // ---- Parse + sanitise filters ------------------------------------------
  const filters: SQL[] = [];

  const actorFilter = isUuid(sp.actor) ? sp.actor : undefined;
  if (actorFilter) filters.push(eq(auditLog.userId, actorFilter));

  const actionFilter =
    typeof sp.action === 'string' && sp.action.trim().length > 0
      ? sp.action.trim()
      : undefined;
  if (actionFilter) filters.push(eq(auditLog.action, actionFilter));

  const entityTypeFilter =
    typeof sp.entityType === 'string' && sp.entityType.trim().length > 0
      ? sp.entityType.trim()
      : undefined;
  if (entityTypeFilter)
    filters.push(eq(auditLog.entityType, entityTypeFilter));

  const dateFrom = parseDateOnly(sp.dateFrom);
  const dateTo = parseDateOnly(sp.dateTo);
  if (dateFrom) filters.push(gte(auditLog.createdAt, dateFrom));
  // dateTo is inclusive end-of-day: use `< dateTo + 1 day`.
  if (dateTo) filters.push(lt(auditLog.createdAt, addDays(dateTo, 1)));

  const whereClause =
    filters.length === 0
      ? undefined
      : filters.length === 1
        ? filters[0]
        : and(...filters);

  // ---- Pagination --------------------------------------------------------
  const pageRaw = Number.parseInt(sp.page ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const offset = (page - 1) * PAGE_SIZE;

  // ---- Total count (for pager + summary) --------------------------------
  const totalRows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(auditLog)
    .where(whereClause);
  const total = Number(totalRows[0]?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ---- Page rows (joined to actor username for the table) ---------------
  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
      userId: auditLog.userId,
      actorUsername: operatorUsers.username,
      actorRole: operatorUsers.role,
    })
    .from(auditLog)
    .leftJoin(operatorUsers, eq(auditLog.userId, operatorUsers.id))
    .where(whereClause)
    .orderBy(desc(auditLog.createdAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  // ---- Facet values for filter dropdowns (always show every option) -----
  // Pull distinct actions + entity types currently in the DB; pull every
  // operator for the actor dropdown. These are tiny lists (~20-50 rows each
  // at V1 scale) so a per-render fetch is fine.
  const [actionFacet, entityTypeFacet, actorFacet] = await Promise.all([
    db
      .selectDistinct({ action: auditLog.action })
      .from(auditLog)
      .orderBy(auditLog.action),
    db
      .selectDistinct({ entityType: auditLog.entityType })
      .from(auditLog)
      .where(sql`${auditLog.entityType} IS NOT NULL`)
      .orderBy(auditLog.entityType),
    db
      .select({
        id: operatorUsers.id,
        username: operatorUsers.username,
      })
      .from(operatorUsers)
      .orderBy(operatorUsers.username),
  ]);

  const actionOptions = actionFacet
    .map((r) => r.action)
    .filter((s): s is string => typeof s === 'string');
  const entityTypeOptions = entityTypeFacet
    .map((r) => r.entityType)
    .filter((s): s is string => typeof s === 'string');

  // ---- Build pager links preserving filters -----------------------------
  function withPage(nextPage: number): string {
    const params = new URLSearchParams();
    if (actorFilter) params.set('actor', actorFilter);
    if (actionFilter) params.set('action', actionFilter);
    if (entityTypeFilter) params.set('entityType', entityTypeFilter);
    if (sp.dateFrom) params.set('dateFrom', sp.dateFrom);
    if (sp.dateTo) params.set('dateTo', sp.dateTo);
    if (nextPage > 1) params.set('page', String(nextPage));
    const qs = params.toString();
    return qs.length > 0 ? `/sistem/audit?${qs}` : '/sistem/audit';
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-100">Audit Log</h1>
        <p
          className="text-sm text-slate-400 mt-1"
          data-testid="audit-total-count"
          data-total={total}
        >
          Toplam {total} kayıt · Sayfa {page}/{totalPages}
        </p>
      </header>

      {/* Filter form. GETs the same page with new query params. Using a
          plain <form method="get"> keeps the page server-rendered without
          a client component. */}
      <form
        method="get"
        action="/sistem/audit"
        data-testid="audit-filter-form"
        className="bg-slate-800 rounded-lg p-4 border border-slate-700 space-y-3"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
              Aktör
            </span>
            <select
              name="actor"
              defaultValue={actorFilter ?? ''}
              data-testid="filter-actor"
              className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-100"
            >
              <option value="">Hepsi</option>
              {actorFacet.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
              Aksiyon
            </span>
            <select
              name="action"
              defaultValue={actionFilter ?? ''}
              data-testid="filter-action"
              className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-100 font-mono"
            >
              <option value="">Hepsi</option>
              {actionOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
              Entity Tipi
            </span>
            <select
              name="entityType"
              defaultValue={entityTypeFilter ?? ''}
              data-testid="filter-entity-type"
              className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-100"
            >
              <option value="">Hepsi</option>
              {entityTypeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
              Başlangıç
            </span>
            <input
              type="date"
              name="dateFrom"
              defaultValue={sp.dateFrom ?? ''}
              data-testid="filter-date-from"
              className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-100"
            />
          </label>

          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
              Bitiş
            </span>
            <input
              type="date"
              name="dateTo"
              defaultValue={sp.dateTo ?? ''}
              data-testid="filter-date-to"
              className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-100"
            />
          </label>

          <div className="flex items-end gap-2">
            <button
              type="submit"
              data-testid="filter-apply"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium"
            >
              Filtrele
            </button>
            <Link
              href="/sistem/audit"
              data-testid="filter-reset"
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-sm"
            >
              Sıfırla
            </Link>
          </div>
        </div>
      </form>

      {/* Table — read-only by design (audit_log is append-only). NO edit
          or delete buttons appear here; S11 will assert this contract. */}
      <div className="bg-slate-800 rounded-lg overflow-hidden border border-slate-700">
        <table
          className="w-full text-sm text-slate-100"
          data-testid="audit-log-table"
        >
          <thead className="bg-slate-700/60 text-xs uppercase tracking-wide text-slate-300">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">Zaman</th>
              <th className="px-4 py-3 text-left font-semibold">Aktör</th>
              <th className="px-4 py-3 text-left font-semibold">Aksiyon</th>
              <th className="px-4 py-3 text-left font-semibold">Entity</th>
              <th className="px-4 py-3 text-left font-semibold">Özet</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                data-testid="audit-row"
                data-action={r.action}
                data-entity-type={r.entityType ?? ''}
                data-actor-id={r.userId ?? ''}
                className="border-t border-slate-700 hover:bg-slate-700/40 align-top"
              >
                <td
                  className="px-4 py-3 text-slate-300 whitespace-nowrap font-mono text-xs"
                  data-testid="audit-row-time"
                >
                  {new Date(r.createdAt).toLocaleString('tr-TR')}
                </td>
                <td className="px-4 py-3" data-testid="audit-row-actor">
                  {r.actorUsername ? (
                    <span className="text-slate-200">
                      {r.actorUsername}
                      {r.actorRole ? (
                        <span className="ml-2 text-[10px] uppercase text-slate-500">
                          {r.actorRole}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-slate-500 italic">sistem</span>
                  )}
                </td>
                <td
                  className="px-4 py-3 font-mono text-xs text-slate-200"
                  data-testid="audit-row-action"
                >
                  {r.action}
                </td>
                <td className="px-4 py-3" data-testid="audit-row-entity">
                  <div className="text-slate-200">{r.entityType ?? '—'}</div>
                  {r.entityId ? (
                    <div className="text-[10px] text-slate-500 font-mono truncate max-w-[14rem]">
                      {r.entityId}
                    </div>
                  ) : null}
                </td>
                <td
                  className="px-4 py-3 text-slate-300"
                  data-testid="audit-row-summary"
                >
                  <Summary metadata={r.metadata} />
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-12 text-center text-sm text-slate-400"
                  data-testid="audit-empty"
                >
                  Bu filtrelerle eşleşen kayıt yok.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Pager */}
      <nav
        className="flex items-center justify-between text-sm text-slate-400"
        data-testid="audit-pager"
      >
        <div>
          {total > 0 ? (
            <>
              {offset + 1} – {Math.min(offset + PAGE_SIZE, total)} /{' '}
              {total} kayıt
            </>
          ) : (
            <>0 kayıt</>
          )}
        </div>
        <div className="flex gap-2">
          {page > 1 ? (
            <Link
              href={withPage(page - 1) as Route}
              data-testid="audit-pager-prev"
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded"
            >
              ← Önceki
            </Link>
          ) : (
            <span className="px-3 py-1.5 text-slate-600 cursor-not-allowed border border-slate-800 rounded">
              ← Önceki
            </span>
          )}
          {page < totalPages ? (
            <Link
              href={withPage(page + 1) as Route}
              data-testid="audit-pager-next"
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded"
            >
              Daha Fazla →
            </Link>
          ) : (
            <span className="px-3 py-1.5 text-slate-600 cursor-not-allowed border border-slate-800 rounded">
              Daha Fazla →
            </span>
          )}
        </div>
      </nav>
    </div>
  );
}

/**
 * Render a compact summary for the metadata jsonb column.
 *
 * Audit metadata is intentionally free-form (route handlers write whatever
 * they think is useful), so the formatter just emits `key=value` pairs in
 * insertion order with a small char budget. Strings, numbers, booleans and
 * null render directly; nested objects render as JSON (truncated).
 */
function Summary({ metadata }: { metadata: unknown }) {
  if (metadata == null) {
    return <span className="text-slate-500">—</span>;
  }
  if (typeof metadata !== 'object') {
    return <span className="font-mono text-xs">{String(metadata)}</span>;
  }
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length === 0) {
    return <span className="text-slate-500">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-mono">
      {entries.slice(0, 8).map(([k, v]) => (
        <span key={k} className="text-slate-300">
          <span className="text-slate-500">{k}=</span>
          {formatValue(v)}
        </span>
      ))}
      {entries.length > 8 ? (
        <span className="text-slate-500">…</span>
      ) : null}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 40 ? s.slice(0, 40) + '…' : s;
  } catch {
    return '[unserialisable]';
  }
}
