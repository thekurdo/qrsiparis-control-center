/**
 * Step 02 — CONFIG_GENERATE (Phase H6).
 *
 * V1: validate the tenant.configSnapshot is non-empty and bump the
 * `tenants.config_version` so downstream steps know which version they
 * are deploying. Real Zod validation against the customer-product's
 * RestaurantConfig schema is V1.5 (cross-repo schema package) — the
 * customer-product owns that schema and we must not duplicate it here.
 *
 * Idempotency: bumps `config_version` exactly once per pipeline by
 * checking the in-memory `ctx.deployment.configVersion` we already
 * computed at runner-boot. If a retried run sees the version already at
 * `+1`, this step is a noop.
 */

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { tenants } from '@/db/schema';

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

export const step02ConfigGenerate: PipelineStep = {
  name: 'CONFIG_GENERATE',
  async forward(ctx) {
    ctx.log('info', 'CONFIG_GENERATE: STUB — verifying configSnapshot, bumping configVersion');

    if (!ctx.tenant.configSnapshot) {
      throw new PipelineError(
        ERROR_CODES.CONFIG_INVALID,
        'tenant.configSnapshot is empty — cannot generate restaurant config',
      );
    }

    // Bump config_version on the tenant row. Idempotent because the bumped
    // value is also written back to ctx.deployment.configVersion so a
    // retry skips the second bump.
    if (
      ctx.deployment.configVersion == null ||
      ctx.deployment.configVersion <= ctx.tenant.configVersion
    ) {
      const newVersion = ctx.tenant.configVersion + 1;
      await db
        .update(tenants)
        .set({ configVersion: newVersion, updatedAt: new Date() })
        .where(eq(tenants.id, ctx.tenant.id));
      ctx.tenant.configVersion = newVersion;
      ctx.deployment.configVersion = newVersion;
      ctx.log('info', `Config version bumped to ${newVersion}`);
    } else {
      ctx.log('info', `Config version already at ${ctx.tenant.configVersion} (idempotent skip)`);
    }

    ctx.log('warn', 'STUB: real Zod validation lands in V1.5 (cross-repo schema package)');
  },
  async rollback() {
    /* noop — config_version bump is not destructive; leaving the higher
       version in place is safe (next deploy will bump again). */
  },
};
