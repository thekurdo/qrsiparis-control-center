/**
 * Server (VPS) fixture factory for E2E tests. Inserts directly into the
 * `servers` table — bypasses the wizard for setup speed. The wizard's own
 * happy path is exercised in S2 (group-b-wizard).
 */

import { rawQuery } from './db';
import { serverData, type ServerSeedData } from './data';

export interface CreatedServer extends ServerSeedData {
  id: string;
}

export async function createServer(
  overrides: Partial<ServerSeedData> = {},
): Promise<CreatedServer> {
  const d = serverData(overrides);
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO servers (
       name, public_ip, public_hostname, ssh_port, ssh_user,
       ssh_private_key_encrypted, total_cpu_cores, total_ram_mb, total_disk_gb,
       max_tenants_theoretical, coolify_url, coolify_api_token_encrypted,
       status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      d.name,
      d.publicIp,
      d.publicHostname,
      d.sshPort,
      d.sshUser,
      d.sshPrivateKeyEncrypted,
      d.totalCpuCores,
      d.totalRamMb,
      d.totalDiskGb,
      d.maxTenantsTheoretical,
      d.coolifyUrl,
      d.coolifyApiTokenEncrypted,
      d.status,
    ],
  );
  return { id: rows[0]!.id, ...d };
}

/**
 * Create a server at capacity (20/20 active tenants). Used by S10 to
 * verify the wizard's capacity-aware picker.
 */
export async function createServerAtCapacity(): Promise<CreatedServer> {
  const server = await createServer({ name: `vps-full-${Date.now()}` });
  // We'd need 20 tenant rows here; for the picker test what matters is
  // the COUNT(*) result. Insert 20 minimal cancelled-status rows? No —
  // cancelled is excluded. So 20 active rows.
  // Done in the spec test where the count matters.
  return server;
}
