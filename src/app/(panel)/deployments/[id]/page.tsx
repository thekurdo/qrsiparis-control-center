/**
 * /deployments/[id] — deploy detail with live SSE log + step progress (Phase H8).
 *
 * Server component. Loads the deployment row plus joined tenant / server /
 * triggered-by-user metadata, then hands off to <DeploymentDetailClient>
 * which subscribes to the SSE log-stream endpoint for live updates.
 *
 * The server fetch hydrates the client with the *current* state (status +
 * accumulated log) so the page renders meaningfully even if the deploy is
 * already terminal (success/failed/rolled_back). For active deploys the
 * client component opens an EventSource against
 * `/api/internal/deployments/{id}/log-stream` and appends new lines as
 * they arrive over Redis pub/sub.
 *
 * Auth: any operator (admin or operator role) can view deployment detail.
 */

import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';

import { db } from '@/db/client';
import { deployments, operatorUsers, servers, tenants } from '@/db/schema';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { DeploymentDetailClient } from '@/components/cc/DeploymentDetailClient';

export default async function DeploymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireOperatorAuth(['admin', 'operator']);

  const [row] = await db
    .select({
      // Deployment fields (flat — JSON-safe to ship to the client)
      deploymentId: deployments.id,
      deploymentType: deployments.deploymentType,
      status: deployments.status,
      appVersion: deployments.appVersion,
      configVersion: deployments.configVersion,
      startedAt: deployments.startedAt,
      completedAt: deployments.completedAt,
      durationSeconds: deployments.durationSeconds,
      triggerReason: deployments.triggerReason,
      log: deployments.log,
      errorMessage: deployments.errorMessage,
      errorCode: deployments.errorCode,
      createdAt: deployments.createdAt,
      // Tenant
      tenantId: tenants.id,
      tenantName: tenants.restaurantName,
      tenantShortCode: tenants.shortCode,
      tenantDomain: tenants.domain,
      // Server
      serverId: servers.id,
      serverName: servers.name,
      serverPublicIp: servers.publicIp,
      // Triggered by
      triggeredByUsername: operatorUsers.username,
      triggeredByFullName: operatorUsers.fullName,
    })
    .from(deployments)
    .leftJoin(tenants, eq(deployments.tenantId, tenants.id))
    .leftJoin(servers, eq(deployments.serverId, servers.id))
    .leftJoin(operatorUsers, eq(deployments.triggeredByUserId, operatorUsers.id))
    .where(eq(deployments.id, id))
    .limit(1);

  if (!row) notFound();

  return <DeploymentDetailClient initial={row} />;
}
