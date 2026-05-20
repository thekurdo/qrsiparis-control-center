/**
 * Re-exported inferred Drizzle types — single import surface for app code.
 *
 * Usage:
 *   import type { Tenant, NewTenant, Deployment } from '@/types/db';
 *
 * Why a separate barrel: schema.ts is large; importing types from it pulls
 * the entire module graph (sql, drizzle-orm, pg-core) into client bundles
 * via `verbatimModuleSyntax`. Keeping a `types/` barrel makes it explicit
 * that no runtime code crosses the boundary.
 */

export type {
  AuditLog,
  Deployment,
  NewAuditLog,
  NewDeployment,
  NewOperatorUser,
  NewServer,
  NewTenant,
  OperatorUser,
  Server,
  Tenant,
} from '@/db/schema';

// ---------------------------------------------------------------------------
// Narrow union types for the enum columns. These match the `enum:` arrays
// declared in schema.ts so consumers can type-check status transitions etc.
// ---------------------------------------------------------------------------

export type OperatorRole = 'admin' | 'operator';

export type ServerStatus = 'active' | 'maintenance' | 'decommissioned' | 'error';
export type ServerHealthStatus = 'healthy' | 'degraded' | 'critical';

export type TenantTier = 'baslangic' | 'standart' | 'profesyonel';
export type TenantStatus = 'onboarding' | 'active' | 'paused' | 'cancelled';
export type TenantContainerStatus =
  | 'not_deployed'
  | 'running'
  | 'stopped'
  | 'error';
export type TenantSalesPartner = 'proviat' | 'diger' | null;

export type DeploymentType =
  | 'initial'
  | 'config_update'
  | 'app_update'
  | 'redeploy'
  | 'rollback'
  | 'delete';

export type DeploymentStatus =
  | 'pending'
  | 'in_progress'
  | 'success'
  | 'failed'
  | 'rolled_back';
