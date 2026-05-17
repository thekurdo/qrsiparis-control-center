/**
 * /musteriler/[id] — tenant detail tabs.
 *
 * Tabs (mirrors UI_DESIGN.md control-center §4):
 *   1. Genel          — kontrat + iletişim + sunucu özeti
 *   2. Konfigürasyon  — `tenants.config_snapshot` JSON pretty-print (Monaco H6+)
 *   3. Deploy Geçmişi — son 10 deploy (link → /deployments/[id])
 *   4. Sağlık         — placeholder (CPU/RAM/disk grafiği H7+)
 *   5. Notlar         — `tenants.internal_notes` (Markdown editör V1.5)
 *
 * Plus the last 50 audit-log entries scoped to this tenant for an audit-
 * trail strip below the tabs.
 *
 * Server component: data fetched in parallel via `Promise.all` so tab
 * switching (client-side, see <Tabs>) is instant after first paint.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { tenants, servers, deployments, auditLog } from '@/db/schema';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { Card } from '@/components/Card';
import { Field } from '@/components/Field';
import {
  StatusPill,
  ContainerStatusPill,
  DeployStatusPill,
  TierBadge,
} from '@/components/StatusPill';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/Tabs';
import { formatTl } from '@/lib/utils/format-tl';
import { EXPECTED_TENANT_SCHEMA_VERSION } from '@/lib/crons/tenant-schema-drift-detector';

function formatDate(d: Date | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('tr-TR');
}

function formatDateTime(d: Date | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('tr-TR');
}

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOperatorAuth(['admin', 'operator']);
  const { id } = await params;

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, id))
    .limit(1);
  if (!tenant) notFound();

  const [server, recentDeployments, recentAudit] = await Promise.all([
    tenant.serverIdRef
      ? db
          .select()
          .from(servers)
          .where(eq(servers.id, tenant.serverIdRef))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db
      .select()
      .from(deployments)
      .where(eq(deployments.tenantId, id))
      .orderBy(desc(deployments.createdAt))
      .limit(10),
    db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityType, 'tenant'), eq(auditLog.entityId, id)),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(50),
  ]);

  const contactSummary = [tenant.contactName, tenant.contactPhone]
    .filter(Boolean)
    .join(' · ');
  const addressSummary = [tenant.city, tenant.address]
    .filter(Boolean)
    .join(', ');

  // Schema drift surface (R18). The cron writes a `tenant.schema_drift`
  // audit row daily, but the banner doesn't need to wait for it — we can
  // compute the drift state inline from the same comparison the cron
  // makes. Cancelled tenants are exempt (they won't receive a migration,
  // so warning ops about them is pure noise — matches the cron filter).
  const isSchemaDrifted =
    tenant.status !== 'cancelled' &&
    tenant.schemaVersion < EXPECTED_TENANT_SCHEMA_VERSION;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/musteriler"
            className="text-blue-400 text-sm hover:underline"
          >
            ← Müşteriler
          </Link>
          <h1 className="text-2xl font-semibold text-slate-100 mt-2">
            {tenant.restaurantName}
          </h1>
          <p className="text-sm text-slate-400 font-mono mt-1">
            {tenant.shortCode} · {tenant.domain}
          </p>
          <div className="flex items-center gap-2 mt-3">
            <StatusPill status={tenant.status} />
            <ContainerStatusPill status={tenant.containerStatus} />
            <TierBadge tier={tenant.tier} />
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <a
            href={`https://${tenant.domain}`}
            target="_blank"
            rel="noreferrer"
            className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm text-slate-100"
          >
            Siteyi Aç
          </a>
          {server?.coolifyUrl ? (
            <a
              href={server.coolifyUrl}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm text-slate-100"
            >
              Coolify
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="px-3 py-2 bg-slate-700 opacity-50 rounded text-sm text-slate-300 cursor-not-allowed"
              title="Sunucuya Coolify URL atanmamış"
            >
              Coolify
            </button>
          )}
          <button
            type="button"
            disabled
            className="px-3 py-2 bg-slate-700 opacity-50 rounded text-sm text-slate-300 cursor-not-allowed"
            title="SSH bağlantısı V1.5'te eklenecek"
          >
            SSH (V1.5)
          </button>
        </div>
      </header>

      {isSchemaDrifted ? (
        <div
          role="alert"
          data-testid="schema-drift-banner"
          data-tenant-version={tenant.schemaVersion}
          data-expected-version={EXPECTED_TENANT_SCHEMA_VERSION}
          className="rounded-lg border border-amber-700 bg-amber-900/30 px-4 py-3 text-sm text-amber-200"
        >
          <span className="font-semibold">Şema sürüm uyumsuzluğu:</span>{' '}
          Bu müşterinin tenant veritabanı şeması v{tenant.schemaVersion}{' '}
          sürümünde; control-center v{EXPECTED_TENANT_SCHEMA_VERSION}{' '}
          bekliyor. Resume / config-update akışından önce aradaki
          migration&apos;ların uygulanması gerekiyor.
        </div>
      ) : null}

      <Tabs defaultValue="genel">
        <TabsList>
          <TabsTrigger value="genel">Genel</TabsTrigger>
          <TabsTrigger value="config">Konfigürasyon</TabsTrigger>
          <TabsTrigger value="deploy">
            Deploy Geçmişi ({recentDeployments.length})
          </TabsTrigger>
          <TabsTrigger value="saglik">Sağlık</TabsTrigger>
          <TabsTrigger value="notlar">Notlar</TabsTrigger>
        </TabsList>

        <TabsContent value="genel">
          <Card>
            <h2 className="font-semibold mb-4 text-slate-100">Bilgiler</h2>
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <Field label="Slug" value={tenant.shortCode} mono />
              <Field label="Domain" value={tenant.domain} mono />
              <Field label="Tier" value={<TierBadge tier={tenant.tier} />} />
              <Field
                label="Durum"
                value={<StatusPill status={tenant.status} />}
              />
              <Field
                label="Sözleşme İmzalandı"
                value={formatDate(tenant.signedAt)}
              />
              <Field
                label="Sözleşme Başl."
                value={formatDate(tenant.contractStartDate)}
              />
              <Field
                label="Sözleşme Bitiş"
                value={formatDate(tenant.contractEndDate)}
              />
              <Field
                label="Aylık Ücret"
                value={formatTl(tenant.monthlyFeeKurus)}
              />
              <Field
                label="İletişim"
                value={contactSummary.length > 0 ? contactSummary : '—'}
              />
              <Field
                label="E-posta"
                value={tenant.contactEmail ?? '—'}
              />
              <Field
                label="Şehir / Adres"
                value={addressSummary.length > 0 ? addressSummary : '—'}
              />
              <Field label="Sunucu" value={server?.name ?? '—'} />
              <Field
                label="Container"
                value={
                  tenant.containerName ? (
                    <span className="font-mono text-xs">
                      {tenant.containerName}
                    </span>
                  ) : (
                    '—'
                  )
                }
              />
              <Field
                label="Satış Ortağı"
                value={tenant.salesPartner ?? 'Direkt'}
              />
              <Field
                label="Komisyon"
                value={`%${tenant.commissionRatePercent}`}
              />
              <Field
                label="Şema Versiyonu"
                value={`v${tenant.schemaVersion}`}
              />
            </dl>
          </Card>

          <Card>
            <h2 className="font-semibold mb-2 text-slate-100">
              Kullanım (V1.5)
            </h2>
            <p className="text-sm text-slate-400">
              Tenant kullanım istatistikleri (toplam ürün/masa/personel/sipariş)
              V1.5&apos;te eklenecek (tenant DB&apos;sine SSH üzerinden erişim
              gerektiriyor).
            </p>
          </Card>
        </TabsContent>

        <TabsContent value="config">
          <Card>
            <h2 className="font-semibold mb-4 text-slate-100">
              Konfigürasyon (Snapshot v{tenant.configVersion})
            </h2>
            {tenant.configSnapshot ? (
              <pre className="bg-slate-900 p-4 rounded text-xs overflow-auto max-h-[600px] text-slate-200 border border-slate-700">
                {JSON.stringify(tenant.configSnapshot, null, 2)}
              </pre>
            ) : (
              <p className="text-sm text-slate-400">
                Bu müşteri için henüz konfigürasyon snapshot&apos;ı yok.
              </p>
            )}
            <p className="text-xs text-slate-500 mt-2">
              Monaco editör Phase H6&apos;da ekleniyor — şimdilik sadece
              görüntüleme.
            </p>
          </Card>
        </TabsContent>

        <TabsContent value="deploy">
          <Card>
            <h2 className="font-semibold mb-4 text-slate-100">
              Son Deploy&apos;lar
            </h2>
            <div className="space-y-2">
              {recentDeployments.map((d) => (
                <Link
                  key={d.id}
                  href={`/deployments/${d.id}`}
                  className="flex items-center justify-between gap-4 p-3 bg-slate-700/50 hover:bg-slate-700 rounded border border-slate-700 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-xs uppercase tracking-wide text-slate-400">
                      {d.deploymentType}
                    </span>
                    <span className="ml-3 text-sm text-slate-200">
                      {d.appVersion ?? '—'}
                    </span>
                    {d.triggerReason ? (
                      <div className="text-xs text-slate-500 mt-1 truncate">
                        {d.triggerReason}
                      </div>
                    ) : null}
                  </div>
                  <DeployStatusPill status={d.status} />
                  <span className="text-xs text-slate-500 whitespace-nowrap">
                    {formatDateTime(d.createdAt)}
                  </span>
                </Link>
              ))}
              {recentDeployments.length === 0 ? (
                <p className="text-sm text-slate-400">Henüz deploy yok.</p>
              ) : null}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="saglik">
          <Card>
            <h2 className="font-semibold mb-2 text-slate-100">Sağlık</h2>
            <p className="text-sm text-slate-400">
              Sağlık grafikleri (CPU/RAM/Disk son 24s ve 7g) Phase H7+&apos;de
              eklenecek.
            </p>
          </Card>
        </TabsContent>

        <TabsContent value="notlar">
          <Card>
            <h2 className="font-semibold mb-4 text-slate-100">İç Notlar</h2>
            <pre className="bg-slate-900 p-4 rounded text-sm whitespace-pre-wrap text-slate-200 border border-slate-700 min-h-[100px]">
              {tenant.internalNotes ?? '(Boş)'}
            </pre>
            <p className="text-xs text-slate-500 mt-2">
              Markdown editörü V1.5&apos;te.
            </p>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Audit trail strip — independent of active tab so operators can always see recent activity */}
      <Card>
        <h2 className="font-semibold mb-4 text-slate-100">
          Son Audit Kayıtları
        </h2>
        {recentAudit.length === 0 ? (
          <p className="text-sm text-slate-400">
            Bu müşteri için audit kaydı yok.
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {recentAudit.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start gap-3 py-1 border-b border-slate-700/50 last:border-b-0"
              >
                <span className="font-mono text-xs text-slate-500 whitespace-nowrap pt-0.5">
                  {formatDateTime(entry.createdAt)}
                </span>
                <span className="font-mono text-xs text-blue-300">
                  {entry.action}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
