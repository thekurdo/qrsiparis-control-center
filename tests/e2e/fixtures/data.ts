/**
 * Deterministic test-data factories. Use these instead of faker so test
 * failures show predictable values and diffing is straightforward.
 *
 * Each invocation increments a module-level counter to keep values unique
 * within a single test run. Call `resetCounter()` in `beforeEach` if you
 * want the same values across tests (e.g. for snapshot-style assertions).
 *
 * Column names match `src/db/schema.ts`. Update both together when the
 * schema changes.
 */

let counter = 0;

export function resetCounter(): void {
  counter = 0;
}

export interface TenantSeedData {
  shortCode: string;
  restaurantName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  city: string;
  tier: 'baslangic' | 'standart' | 'profesyonel';
  monthlyFeeKurus: number;
  signedAt: Date;
  contractStartDate: Date;
  contractEndDate: Date;
  domain: string;
}

export function tenantData(overrides: Partial<TenantSeedData> = {}): TenantSeedData {
  const n = ++counter;
  const now = new Date();
  return {
    shortCode: `test-tenant-${n}`,
    restaurantName: `Test Restoran ${n}`,
    contactName: 'Ali Veli',
    contactPhone: `+9055500000${String(n).padStart(2, '0')}`,
    contactEmail: `tenant${n}@test.local`,
    city: 'İstanbul',
    tier: 'baslangic',
    monthlyFeeKurus: 50_000,
    signedAt: now,
    contractStartDate: now,
    contractEndDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    domain: `test-tenant-${n}.test.local`,
    ...overrides,
  };
}

export interface ServerSeedData {
  name: string;
  publicIp: string;
  publicHostname: string;
  sshPort: number;
  sshUser: string;
  sshPrivateKeyEncrypted: string;
  totalCpuCores: number;
  totalRamMb: number;
  totalDiskGb: number;
  maxTenantsTheoretical: number;
  coolifyUrl: string;
  coolifyApiTokenEncrypted: string;
  status: 'active' | 'maintenance' | 'decommissioned' | 'error';
}

export function serverData(overrides: Partial<ServerSeedData> = {}): ServerSeedData {
  const n = ++counter;
  return {
    name: `vps-test-${n}`,
    publicIp: `10.0.${n}.1`,
    publicHostname: `vps${n}.test.local`,
    sshPort: 22,
    sshUser: 'root',
    sshPrivateKeyEncrypted: 'fake-iv:fake-tag:fake-cipher',
    totalCpuCores: 4,
    totalRamMb: 16384,
    totalDiskGb: 100,
    maxTenantsTheoretical: 20,
    coolifyUrl: process.env['COOLIFY_API_URL'] ?? 'http://localhost:58080',
    coolifyApiTokenEncrypted: 'fake-iv:fake-tag:fake-cipher',
    status: 'active',
    ...overrides,
  };
}

export interface OperatorSeedData {
  username: string;
  email: string;
  fullName: string;
  passwordHash: string;
  role: 'admin' | 'operator';
}

/**
 * Pre-computed bcrypt hash (cost 12) of `TEST_PASSWORD`. Generated once and
 * checked in so tests don't pay the ~250ms hashing cost on every call.
 */
export const TEST_PASSWORD = 'TestPass123!';
export const TEST_PASSWORD_HASH =
  '$2b$12$HQFxdWkz.MDt/0fGSnX79./vLHXMQ.FoQaDemRHa4MTlrxRvsAbiK';

export function operatorData(overrides: Partial<OperatorSeedData> = {}): OperatorSeedData {
  const n = ++counter;
  return {
    username: `test-operator-${n}`,
    email: `op${n}@cyxares.test`,
    fullName: `Test Operator ${n}`,
    passwordHash: TEST_PASSWORD_HASH,
    role: 'operator',
    ...overrides,
  };
}
