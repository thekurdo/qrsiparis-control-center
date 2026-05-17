/**
 * Tenant fixture factory for E2E tests. Inserts directly into the
 * `tenants` table — bypasses the wizard for setup speed.
 */

import { rawQuery } from './db';
import { tenantData, type TenantSeedData } from './data';

export interface CreatedTenant extends TenantSeedData {
  id: string;
  serverIdRef: string;
  status: 'onboarding' | 'active' | 'paused' | 'cancelled';
  containerStatus: 'not_deployed' | 'running' | 'stopped' | 'error';
}

export async function createTenant(
  serverId: string,
  overrides: Partial<TenantSeedData> & {
    status?: CreatedTenant['status'];
    containerStatus?: CreatedTenant['containerStatus'];
    containerName?: string;
    /**
     * Tenant's reported DB schema version. Defaults to 1 (V1 baseline).
     * S16 (schema drift detector) flips this through the range
     * [1 .. EXPECTED_TENANT_SCHEMA_VERSION] to drive the drift cron.
     */
    schemaVersion?: number;
  } = {},
): Promise<CreatedTenant> {
  const {
    status: statusO,
    containerStatus: csO,
    containerName,
    schemaVersion: schemaVersionO,
    ...rest
  } = overrides;
  const d = tenantData(rest);
  const status = statusO ?? 'onboarding';
  const containerStatus = csO ?? 'not_deployed';
  const schemaVersion = schemaVersionO ?? 1;
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO tenants (
       short_code, restaurant_name, contact_name, contact_phone, contact_email,
       city, tier, signed_at, contract_start_date, contract_end_date,
       monthly_fee_kurus, server_id_ref, domain, status, container_status,
       container_name, config_version, schema_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,$17)
     RETURNING id`,
    [
      d.shortCode,
      d.restaurantName,
      d.contactName,
      d.contactPhone,
      d.contactEmail,
      d.city,
      d.tier,
      d.signedAt,
      d.contractStartDate,
      d.contractEndDate,
      d.monthlyFeeKurus,
      serverId,
      d.domain,
      status,
      containerStatus,
      containerName ?? null,
      schemaVersion,
    ],
  );
  return {
    id: rows[0]!.id,
    serverIdRef: serverId,
    status,
    containerStatus,
    ...d,
  };
}

/**
 * Convenience: an active, running tenant ready for lifecycle tests
 * (pause/resume/cancel in S13).
 */
export async function createActiveTenant(
  serverId: string,
  overrides: Partial<TenantSeedData> & {
    schemaVersion?: number;
  } = {},
): Promise<CreatedTenant> {
  return createTenant(serverId, {
    ...overrides,
    status: 'active',
    containerStatus: 'running',
    containerName: `rest-${overrides.shortCode ?? `test-${Date.now()}`}`,
  });
}

/**
 * Convenience: a tenant ready for a full happy-path deployment pipeline.
 *
 * The default `createTenant()` fixture doesn't populate `config_snapshot`,
 * which is the field step02 (CONFIG_GENERATE) checks via
 * `if (!ctx.tenant.configSnapshot)` — leaving it null fails the pipeline
 * in ~25ms with code `CONFIG_INVALID`, well before any downstream
 * pipeline assertions (live logs, lock checks, rollback ordering) can
 * fire. This helper seeds a minimal-but-shaped snapshot so the happy
 * path completes in ~3-4s.
 *
 * The exact shape isn't load-bearing for V1 — step02 only checks
 * presence. V1.5 will land Zod validation against the customer-product's
 * RestaurantConfig schema; this seed will need updating then (and
 * callers should review whether their test still wants a happy path).
 *
 * Used by S17 (concurrent lock) and S18 (SSE log stream), and any
 * future deploy-pipeline scenario that wants step02 to pass.
 */
export async function createDeployableTenant(
  serverId: string,
  overrides: Partial<TenantSeedData> & {
    status?: CreatedTenant['status'];
    containerStatus?: CreatedTenant['containerStatus'];
    containerName?: string;
  } = {},
): Promise<CreatedTenant> {
  const tenant = await createTenant(serverId, overrides);
  await rawQuery(`UPDATE tenants SET config_snapshot = $1::jsonb WHERE id = $2`, [
    JSON.stringify({
      step1: { restaurantName: tenant.restaurantName },
      step3: { domain: tenant.domain },
    }),
    tenant.id,
  ]);
  return tenant;
}
