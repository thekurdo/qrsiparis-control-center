/**
 * Step 09 — DOMAIN_VERIFICATION (Phase H6 STUB).
 *
 * Real implementation (Phase H7):
 *   - HEAD https://{tenant.domain}/         (landing — must be 200)
 *   - HEAD https://{tenant.domain}/admin    (admin login — must be 200)
 *   - HEAD https://{tenant.domain}/menu     (customer menu — must be 200)
 *   - Throw `LANDING_UNREACHABLE` / `ADMIN_UNREACHABLE` on failure.
 *
 * Idempotency: read-only HTTP; safe to retry.
 */

import type { PipelineStep } from '../pipeline';

export const step09DomainVerification: PipelineStep = {
  name: 'DOMAIN_VERIFICATION',
  async forward(ctx) {
    const base = `https://${ctx.tenant.domain}`;
    ctx.log('info', `STUB: verify landing ${base}/`);
    ctx.log('info', `STUB: verify admin   ${base}/admin`);
    ctx.log('info', `STUB: verify menu    ${base}/menu`);
    ctx.log('info', 'DOMAIN_VERIFICATION: stub OK');
  },
  async rollback() {
    /* noop — verification is read-only */
  },
};
