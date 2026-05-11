/**
 * Step 01 — PRECHECK (Phase H6).
 *
 * Gates the pipeline before any side effects fire. Verifies:
 *   1. Tenant exists, is not cancelled, has a server assigned.
 *   2. Server is `active` and not `critical`.
 *   3. Server still has capacity headroom (current tenant count <
 *      `maxTenantsTheoretical`, excluding this tenant + cancelled rows).
 *
 * Throws `PipelineError` with the appropriate `ERROR_CODES.*` value so the
 * runner can stamp `deployments.error_code` for the operator UI.
 *
 * Idempotency: read-only; rollback is a noop.
 */

import { and, count, eq, ne } from 'drizzle-orm';

import { db } from '@/db/client';
import { tenants } from '@/db/schema';

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

export const step01Precheck: PipelineStep = {
  name: 'PRECHECK',
  async forward(ctx) {
    ctx.log('info', 'Precheck: tenant exists, not cancelled, has server');

    if (ctx.tenant.status === 'cancelled') {
      throw new PipelineError(ERROR_CODES.TENANT_CANCELLED, 'Tenant is cancelled');
    }
    if (!ctx.tenant.serverIdRef) {
      throw new PipelineError(ERROR_CODES.NO_SERVER, 'Tenant has no server assigned');
    }

    // Server health
    if (ctx.server.status !== 'active') {
      throw new PipelineError(
        ERROR_CODES.SERVER_NOT_ACTIVE,
        `Server status: ${ctx.server.status}`,
      );
    }
    if (ctx.server.lastHealthStatus === 'critical') {
      throw new PipelineError(ERROR_CODES.SERVER_UNHEALTHY, 'Server unhealthy');
    }

    // Capacity check — exclude this tenant (re-deploy is allowed at full
    // capacity for the tenant already counted) and cancelled rows.
    const cap = ctx.server.maxTenantsTheoretical ?? 20;
    const currentResult = await db
      .select({ c: count() })
      .from(tenants)
      .where(
        and(
          eq(tenants.serverIdRef, ctx.server.id),
          ne(tenants.status, 'cancelled'),
          ne(tenants.id, ctx.tenant.id),
        ),
      )
      .then((r) => Number(r[0]?.c ?? 0));
    if (currentResult >= cap) {
      throw new PipelineError(
        ERROR_CODES.SERVER_FULL,
        `Server at capacity (${currentResult}/${cap})`,
      );
    }

    ctx.log('info', `Precheck OK (server has ${currentResult}/${cap} tenants)`);
  },
  async rollback() {
    /* noop — no DB writes in this step */
  },
};
