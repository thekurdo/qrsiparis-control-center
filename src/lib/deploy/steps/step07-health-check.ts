/**
 * Step 07 — HEALTH_CHECK (Phase H6 STUB).
 *
 * Real implementation (Phase H7):
 *   - HTTP GET https://{tenant.domain}/api/health every 2s, 60s timeout.
 *   - Expect 200 + `{ ok: true, schemaVersion, appVersion }`.
 *   - Throw `HEALTH_CHECK_FAILED` on persistent non-2xx or schema mismatch.
 *
 * Idempotency: read-only over HTTP; no rollback semantics (the container
 * is either healthy or it isn't).
 */

import type { PipelineStep } from '../pipeline';

export const step07HealthCheck: PipelineStep = {
  name: 'HEALTH_CHECK',
  async forward(ctx) {
    ctx.log(
      'info',
      `STUB: fetch https://${ctx.tenant.domain}/api/health, poll every 2s (timeout 60s)`,
    );
    ctx.log('info', 'HEALTH_CHECK: stub OK');
  },
  async rollback() {
    /* noop — health check is read-only */
  },
};
