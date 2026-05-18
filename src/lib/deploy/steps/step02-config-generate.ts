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

    // Generate the tenant's docker-compose YAML. V1 ships a minimal
    // nginx-based stack as proof-of-concept; V1.5 will swap this for the
    // real `qrsiparis-app` image once it's published to a registry.
    ctx.tenantComposeYaml = generateTenantCompose({
      shortCode: ctx.tenant.shortCode,
      domain: ctx.tenant.domain,
      restaurantName: ctx.tenant.restaurantName,
    });
    ctx.log('info', `Generated tenant compose YAML (${ctx.tenantComposeYaml.length} bytes)`);
  },
  async rollback() {
    /* noop — config_version bump is not destructive; leaving the higher
       version in place is safe (next deploy will bump again). */
  },
};

/**
 * Generate the per-tenant docker-compose YAML that Coolify will deploy.
 *
 * V1 ships a minimal nginx hello-world stack as proof that the full
 * SaaS plumbing (Coolify API, DNS, SSL, Traefik routing) works end-to-end.
 * Each tenant gets:
 *   - A single `app` service on port 80
 *   - SERVICE_FQDN_APP magic var → Coolify wires Traefik routing + SSL
 *   - Custom HTML showing the restaurant name so we can visually confirm
 *     per-tenant isolation
 *
 * V1.5: replace `nginx:alpine` + the inline HTML with the real
 * `qrsiparis-app` image pulled from a registry, plus a Postgres/SQLite
 * volume for that tenant's data.
 */
function generateTenantCompose(args: {
  shortCode: string;
  domain: string;
  restaurantName: string;
}): string {
  // V1 minimal nginx — Coolify's compose parser is finicky about embedded
  // shell commands with mixed quoting. Keep it simple: just nginx-alpine
  // + the SERVICE_FQDN magic env so Traefik routes <domain> to port 80.
  // V1.5 swaps `nginx:alpine` for the qrsiparis-app image with the
  // tenant's config baked in.
  return `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    environment:
      - SERVICE_FQDN_APP_80=${args.domain}
      - TENANT_SHORT_CODE=${args.shortCode}
      - TENANT_RESTAURANT_NAME=${JSON.stringify(args.restaurantName)}
`;
}
