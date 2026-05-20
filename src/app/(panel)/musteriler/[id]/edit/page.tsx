/**
 * /musteriler/[id]/edit — operator-driven config edit (V1.5).
 *
 * Server component shell. Loads the tenant row + current `config_snapshot`
 * and hands off to <TenantConfigEditClient> which renders the form and
 * POSTs back to `/api/internal/tenants/[id]/config`.
 *
 * Auth: admin only — config edits can break a customer's live site (wrong
 * brand color is recoverable, but flipping `modules.admin: false` while the
 * tenant is live would lock the operator out of their own panel). We scope
 * write access to admins; operator role can view the current snapshot via
 * the read-only tab on the detail page but not edit it.
 *
 * Cancelled tenants are 404'd here so the edit URL doesn't render a form
 * the API would reject anyway (the route returns BUSINESS_RULE_VIOLATION
 * for status='cancelled'). Showing the form and surprising the operator
 * with an error on submit is a worse UX than just hiding the entry point.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { tenants } from '@/db/schema';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { TenantConfigEditClient } from '@/components/cc/TenantConfigEditClient';

export default async function TenantConfigEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOperatorAuth(['admin']);
  const { id } = await params;

  const [tenant] = await db
    .select({
      id: tenants.id,
      shortCode: tenants.shortCode,
      restaurantName: tenants.restaurantName,
      domain: tenants.domain,
      tier: tenants.tier,
      status: tenants.status,
      configSnapshot: tenants.configSnapshot,
      configVersion: tenants.configVersion,
    })
    .from(tenants)
    .where(eq(tenants.id, id))
    .limit(1);
  if (!tenant) notFound();

  // Hide the edit form for cancelled tenants — the API would reject the
  // submit anyway, so save the operator a wasted round-trip.
  if (tenant.status === 'cancelled') notFound();

  return (
    <div className="space-y-6">
      <header>
        <Link
          href={`/musteriler/${tenant.id}`}
          className="text-blue-400 text-sm hover:underline"
        >
          ← {tenant.restaurantName}
        </Link>
        <h1 className="text-2xl font-semibold text-slate-100 mt-2">
          Konfigürasyonu Düzenle
        </h1>
        <p className="text-sm text-slate-400 font-mono mt-1">
          {tenant.shortCode} · {tenant.domain} · snapshot v
          {tenant.configVersion}
        </p>
      </header>

      <TenantConfigEditClient
        tenantId={tenant.id}
        initialSnapshot={
          (tenant.configSnapshot as Record<string, unknown> | null) ?? {}
        }
      />
    </div>
  );
}
