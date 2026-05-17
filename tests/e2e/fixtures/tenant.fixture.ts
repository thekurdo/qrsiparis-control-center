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
  } = {},
): Promise<CreatedTenant> {
  const { status: statusO, containerStatus: csO, containerName, ...rest } = overrides;
  const d = tenantData(rest);
  const status = statusO ?? 'onboarding';
  const containerStatus = csO ?? 'not_deployed';
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO tenants (
       short_code, restaurant_name, contact_name, contact_phone, contact_email,
       city, tier, signed_at, contract_start_date, contract_end_date,
       monthly_fee_kurus, server_id_ref, domain, status, container_status,
       container_name, config_version, schema_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,1)
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
  overrides: Partial<TenantSeedData> = {},
): Promise<CreatedTenant> {
  return createTenant(serverId, {
    ...overrides,
    status: 'active',
    containerStatus: 'running',
    containerName: `rest-${overrides.shortCode ?? `test-${Date.now()}`}`,
  });
}
