/**
 * Step 08 — SSL_CERTIFICATE (Phase H6 STUB).
 *
 * Real implementation (Phase H7):
 *   - Poll Coolify's certificate status endpoint until status === 'issued'
 *     or 120s elapses (Let's Encrypt rate limits + DNS propagation).
 *   - Throw `SSL_TIMEOUT` on timeout. Don't auto-retry — the operator
 *     needs to verify DNS / domain validation manually.
 *
 * Idempotency: Coolify dedupes cert issuance by domain. A retried run
 * either picks up an already-issued cert immediately or continues
 * polling the same in-flight challenge.
 */

import type { PipelineStep } from '../pipeline';

export const step08SslCertificate: PipelineStep = {
  name: 'SSL_CERTIFICATE',
  async forward(ctx) {
    ctx.log(
      'info',
      `STUB: Let's Encrypt cert poll for ${ctx.tenant.domain} (timeout 120s)`,
    );
    ctx.log('info', 'SSL_CERTIFICATE: stub issued');
  },
  async rollback() {
    /* noop — cert revocation is V1.5+ and manual */
  },
};
