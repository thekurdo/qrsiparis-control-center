/**
 * /musteriler/yeni — 7-step tenant onboarding wizard (Phase H5).
 *
 * Server-component shell:
 *   - Auth-gates the route to admin operators (operators can view tenants but
 *     creation is admin-only per IMPL §3 role matrix).
 *   - Loads `servers` + per-server tenant counts so Step 6 (server picker, in
 *     H5b) can render capacity badges without an extra round-trip.
 *
 * The interactive multi-step state lives in `<TenantWizardClient>` which
 * persists progress to localStorage with a 7-day TTL.
 */

import { and, eq, ne, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { servers, tenants } from '@/db/schema';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { TenantWizardClient } from '@/components/wizard/TenantWizardClient';

export default async function YeniMusteriPage() {
  await requireOperatorAuth(['admin']);

  // Active servers only — paused/decommissioned hosts can't accept new tenants.
  const allServers = await db
    .select()
    .from(servers)
    .where(eq(servers.status, 'active'));

  // Live tenant count per server. We exclude `cancelled` so freed-up slots
  // don't keep counting against a server's capacity ceiling.
  const counts = await db
    .select({
      serverId: tenants.serverIdRef,
      count: sql<number>`COUNT(*)`,
    })
    .from(tenants)
    .where(
      and(
        sql`${tenants.serverIdRef} IS NOT NULL`,
        ne(tenants.status, 'cancelled'),
      ),
    )
    .groupBy(tenants.serverIdRef);

  const countMap = new Map(counts.map((c) => [c.serverId, Number(c.count)]));
  const serversWithCapacity = allServers.map((s) => ({
    ...s,
    currentTenantCount: countMap.get(s.id) ?? 0,
  }));

  return <TenantWizardClient servers={serversWithCapacity} />;
}
