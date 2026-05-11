/**
 * Step 03 — COOLIFY_APP_CREATE (Phase H6 STUB).
 *
 * Real implementation (Phase H7):
 *   - Calls Coolify HTTP API to create a new application bound to the
 *     tenant's domain + assigned server.
 *   - Stamps the returned UUID onto `ctx.coolifyUuid` AND persists it to
 *     `tenants.container_name` (or a dedicated coolify_uuid column) so
 *     later deploys / rollbacks can find it.
 *
 * V1 stub generates a fake UUID so downstream steps have something to
 * work with during smoke testing.
 *
 * Idempotency: if `ctx.coolifyUuid` is already set (e.g. from a retried
 * pipeline), skip the create call and reuse it.
 */

import crypto from 'node:crypto';

import type { PipelineStep } from '../pipeline';

export const step03CoolifyAppCreate: PipelineStep = {
  name: 'COOLIFY_APP_CREATE',
  async forward(ctx) {
    if (ctx.coolifyUuid) {
      ctx.log('info', `COOLIFY_APP_CREATE: existing uuid=${ctx.coolifyUuid} (idempotent skip)`);
      return;
    }

    ctx.log(
      'info',
      `STUB: would call coolify.createApp({ name: ${ctx.tenant.shortCode}, domain: ${ctx.tenant.domain}, server: ${ctx.server.id} })`,
    );

    // Generate a fake UUID so step05/06 can pretend to use it.
    ctx.coolifyUuid = `coolify-${crypto.randomUUID()}`;
    ctx.log('info', `COOLIFY_APP_CREATE: stub uuid=${ctx.coolifyUuid}`);
  },
  async rollback(ctx) {
    if (!ctx.coolifyUuid) return;
    ctx.log('warn', `STUB: would call coolify.deleteApp(${ctx.coolifyUuid})`);
  },
};
