/**
 * QrSiparis Control Center — PostgreSQL Drizzle schema (Phase H1).
 *
 * Five tables:
 *   1. operator_users — Cyxares + ops team accounts (admin / operator roles)
 *   2. tenants        — Customer restaurants (onboarding -> active lifecycle)
 *   3. servers        — Hostinger VPS fleet with capacity + health metadata
 *   4. deployments    — Pipeline run history (BullMQ-driven; 5 deploy types)
 *   5. audit_log      — Append-only operator action trail (DB trigger enforces)
 *
 * Authoritative spec sources (precedence top-down):
 *   - plan/IMPLEMENTATION_NOTES.md §3 (operator_users) + §4 R13-R18
 *   - 17_INTERNAL_ONBOARDING_PANEL.md §3.1-3.5 (column names)
 *   - 18_DEPLOYMENT_PIPELINE.md §17 (PipelineError codes)
 *
 * Encryption: `lib/crypto/aes-gcm.ts` is used at the application layer for the
 * fields marked `(encrypted)` below. The DB stores opaque AES-GCM blobs in
 * the format `<ivHex>:<tagHex>:<ciphertextHex>`. Phase H6/H7 helpers will
 * encrypt-on-write and decrypt-on-read; this schema only declares the columns.
 *
 * Drift watch (R18): `tenants.schema_version` is bumped by per-tenant
 * migration runs; the `tenant-schema-drift-detector` cron compares this
 * against control-center's known schema version on tenant resume.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// 1. operator_users
// ---------------------------------------------------------------------------
// Auth + 2FA TOTP for Cyxares + 1-2 ops. Role enum: admin | operator.
// `two_factor_secret` and each entry of `two_factor_backup_codes` are stored
// as AES-256-GCM blobs (lib/crypto/aes-gcm.ts) — never plaintext.
// Doc 17 §3.4 + IMPL §3 (4 backup codes per H2).
export const operatorUsers = pgTable(
  'operator_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    twoFactorSecret: text('two_factor_secret'), // (encrypted) TOTP secret
    twoFactorBackupCodes: text('two_factor_backup_codes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`), // (encrypted) exactly 4 codes when 2FA enabled
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    role: text('role', { enum: ['admin', 'operator'] })
      .notNull()
      .default('admin'),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    lastLoginIp: text('last_login_ip'), // hashed (R8/KVKK)
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    failedLoginLockedUntil: timestamp('failed_login_locked_until', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    usernameUq: uniqueIndex('uq_operator_users_username').on(t.username),
    emailUq: uniqueIndex('uq_operator_users_email').on(t.email),
    isActiveIdx: index('idx_operator_users_is_active').on(t.isActive),
    // The array tops out at 4 codes (set by /verify-setup) and counts DOWN
    // as the operator consumes backup codes (S12). The prior constraint
    // locked it at exactly 4 which contradicted the consume-on-login flow
    // in `verifyAndConsumeBackupCode` — the UPDATE that trimmed the array
    // tripped the constraint and rolled back, making a successful
    // backup-code login impossible.
    //
    // We now enforce only the upper bound. `array_length(x, 1)` returns
    // NULL for an empty array `{}`, so the COALESCE covers the burned-all
    // and disabled cases. The user who has burned all 4 codes can still
    // log in via TOTP — they're just locked out of the backup path until
    // an admin resets their 2FA (which writes 4 fresh codes).
    backupCodesCount: check(
      'ck_operator_users_backup_codes_count',
      sql`COALESCE(array_length(${t.twoFactorBackupCodes}, 1), 0) <= 4`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 2. servers
// ---------------------------------------------------------------------------
// Hostinger VPS fleet. Capacity is binding via IMPL §1.PB3:
//   max tenants = 20 (16384 MB / 768 MB per container - 1.6 GB headroom).
// `coolify_api_token_encrypted` and `ssh_private_key_encrypted` are AES-GCM.
export const servers = pgTable(
  'servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    provider: text('provider').notNull().default('hostinger'),
    publicIp: text('public_ip').notNull(),
    publicHostname: text('public_hostname'),
    sshPort: integer('ssh_port').notNull().default(22),
    sshUser: text('ssh_user').notNull().default('root'),
    sshPrivateKeyEncrypted: text('ssh_private_key_encrypted'), // (encrypted)
    totalCpuCores: integer('total_cpu_cores').notNull(),
    totalRamMb: integer('total_ram_mb').notNull(),
    totalDiskGb: integer('total_disk_gb').notNull(),
    cpuPerTenantCenti: integer('cpu_per_tenant_centi').notNull().default(50),
    ramPerTenantMb: integer('ram_per_tenant_mb').notNull().default(768),
    maxTenantsTheoretical: integer('max_tenants_theoretical')
      .notNull()
      .default(20), // IMPL §1.PB3 capacity contract
    status: text('status', {
      enum: ['active', 'maintenance', 'decommissioned', 'error'],
    })
      .notNull()
      .default('active'),
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    lastHealthStatus: text('last_health_status', {
      enum: ['healthy', 'degraded', 'critical'],
    }),
    cpuUsagePct: integer('cpu_usage_pct'),
    ramUsagePct: integer('ram_usage_pct'),
    diskUsagePct: integer('disk_usage_pct'),
    uptimeDays: integer('uptime_days'),
    coolifyUrl: text('coolify_url'),
    coolifyApiTokenEncrypted: text('coolify_api_token_encrypted'), // (encrypted)
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nameUq: uniqueIndex('uq_servers_name').on(t.name),
    statusIdx: index('idx_servers_status').on(t.status),
    cpuPerTenantBounds: check(
      'ck_servers_cpu_per_tenant_centi_bounds',
      sql`${t.cpuPerTenantCenti} >= 1 AND ${t.cpuPerTenantCenti} <= 1000`,
    ),
    ramPerTenantBounds: check(
      'ck_servers_ram_per_tenant_mb_bounds',
      sql`${t.ramPerTenantMb} >= 128 AND ${t.ramPerTenantMb} <= 4096`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 3. tenants
// ---------------------------------------------------------------------------
// Customer restaurants. `short_code` is the URL/container slug:
//   regex /^[a-z0-9-]+$/, length 3-50 (CHECK constraint enforced server-side).
// `schema_version` supports R18 drift detection (IMPL §4).
// `sales_partner` accepts 'proviat' | 'diger' (V1.5) | NULL (V1 default).
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shortCode: text('short_code').notNull(),
    restaurantName: text('restaurant_name').notNull(),
    contactName: text('contact_name').notNull(),
    contactPhone: text('contact_phone').notNull(),
    contactEmail: text('contact_email'),
    address: text('address'),
    city: text('city').notNull(),
    tier: text('tier', { enum: ['baslangic', 'standart', 'profesyonel'] })
      .notNull()
      .default('baslangic'),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    contractStartDate: timestamp('contract_start_date', {
      withTimezone: true,
    }).notNull(),
    contractEndDate: timestamp('contract_end_date', {
      withTimezone: true,
    }).notNull(),
    monthlyFeeKurus: bigint('monthly_fee_kurus', { mode: 'number' }).notNull(),
    salesPartner: text('sales_partner', { enum: ['proviat', 'diger'] }), // NULL = direkt; 'diger' = V1.5
    commissionRatePercent: integer('commission_rate_percent')
      .notNull()
      .default(0),
    serverIdRef: uuid('server_id_ref').references(() => servers.id, {
      onDelete: 'set null',
    }),
    domain: text('domain').notNull(),
    containerName: text('container_name'),
    containerStatus: text('container_status', {
      enum: ['not_deployed', 'running', 'stopped', 'error'],
    })
      .notNull()
      .default('not_deployed'),
    configSnapshot: jsonb('config_snapshot'),
    configVersion: integer('config_version').notNull().default(1),
    status: text('status', {
      enum: ['onboarding', 'active', 'paused', 'cancelled'],
    })
      .notNull()
      .default('onboarding'),
    internalNotes: text('internal_notes'),
    schemaVersion: integer('schema_version').notNull().default(1), // R18
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    shortCodeUq: uniqueIndex('uq_tenants_short_code').on(t.shortCode),
    domainUq: uniqueIndex('uq_tenants_domain').on(t.domain),
    statusIdx: index('idx_tenants_status').on(t.status),
    serverIdx: index('idx_tenants_server_id_ref').on(t.serverIdRef),
    shortCodeFormat: check(
      'ck_tenants_short_code_format',
      sql`${t.shortCode} ~ '^[a-z0-9-]+$' AND char_length(${t.shortCode}) BETWEEN 3 AND 50`,
    ),
    commissionBounds: check(
      'ck_tenants_commission_rate_bounds',
      sql`${t.commissionRatePercent} >= 0 AND ${t.commissionRatePercent} <= 100`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 4. deployments
// ---------------------------------------------------------------------------
// Pipeline run history. `error_code` mirrors PipelineError codes from Doc 18
// §17 (TENANT_NOT_FOUND, SERVER_FULL, HEALTH_CHECK_FAILED, ...). Stored as
// free text rather than enum so future codes don't need migrations.
export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'restrict' }),
    deploymentType: text('deployment_type', {
      enum: [
        'initial',
        'config_update',
        'app_update',
        'redeploy',
        'rollback',
        'delete',
      ],
    }).notNull(),
    status: text('status', {
      enum: ['pending', 'in_progress', 'success', 'failed', 'rolled_back'],
    })
      .notNull()
      .default('pending'),
    appVersion: text('app_version').notNull(),
    configVersion: integer('config_version'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    triggeredByUserId: uuid('triggered_by_user_id').references(
      () => operatorUsers.id,
      { onDelete: 'set null' },
    ),
    triggerReason: text('trigger_reason'),
    log: text('log'), // accumulated streaming logs (flushLogs)
    errorMessage: text('error_message'),
    errorCode: text('error_code'), // PipelineError.code
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index('idx_deployments_tenant_id').on(t.tenantId),
    statusIdx: index('idx_deployments_status').on(t.status),
    createdAtIdx: index('idx_deployments_created_at').on(t.createdAt),
    // composite for "recent deploys for tenant by status" + "stuck recovery"
    tenantStatusCreatedIdx: index('idx_deployments_tenant_status_created').on(
      t.tenantId,
      t.status,
      t.createdAt,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 4b. deployment_history — point-in-time snapshots after every successful
// pipeline. Powers the rollback step's config restoration (image-only
// rollback was V1.5; full restore lands here in V2). Append-only; never
// updated. The `archived_at` column marks rows we've already rolled
// back to (so a chain of rollbacks doesn't keep picking the same row).
// ---------------------------------------------------------------------------
export const deploymentHistory = pgTable(
  'deployment_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    deploymentId: uuid('deployment_id').references(() => deployments.id, {
      onDelete: 'set null',
    }),
    appVersion: text('app_version').notNull(),
    configSnapshot: jsonb('config_snapshot').notNull(),
    configVersion: integer('config_version').notNull(),
    // 'success' for normal capture rows; 'rolled_back' marks a target row
    // the operator already rolled BACK to (so we skip it next time).
    status: text('status', { enum: ['success', 'rolled_back'] })
      .notNull()
      .default('success'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index('idx_deployment_history_tenant_id').on(t.tenantId),
    tenantCreatedIdx: index('idx_deployment_history_tenant_created').on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 5. audit_log
// ---------------------------------------------------------------------------
// Append-only operator action trail. UPDATE/DELETE rejected by DB trigger
// (created in initial migration; declared here in `auditLogTriggers` SQL).
// `entity_id` is text to support both UUID PKs and string identifiers.
// `ip_address` and `user_agent` are SHA-256 hashed (KVKK gate item).
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => operatorUsers.id, {
      onDelete: 'set null',
    }), // NULL allowed for system actions (cron, worker)
    action: text('action').notNull(), // e.g. 'tenant.created', 'deploy.success'
    entityType: text('entity_type'),
    entityId: text('entity_id'), // UUID or arbitrary string identifier
    metadata: jsonb('metadata'),
    ipAddress: text('ip_address'), // hashed
    userAgent: text('user_agent'), // hashed
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('idx_audit_log_user_created').on(
      t.userId,
      t.createdAt,
    ),
    entityIdx: index('idx_audit_log_entity').on(t.entityType, t.entityId),
    createdAtIdx: index('idx_audit_log_created_at').on(t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Triggers (raw SQL — emitted by initial migration)
// ---------------------------------------------------------------------------
// Drizzle does not have a first-class trigger DSL; these statements are
// executed in the first migration (or via `db:generate` custom SQL) and are
// also exported here so the migration runner / tests can include them.
//
// 1. `set_updated_at()` — generic recursion-guarded updated_at trigger
// 2. `tr_<table>_updated_at` — wired to operator_users / servers / tenants
// 3. `reject_audit_modify()` + `tr_audit_log_immutable` — append-only trigger
//
// `deployments` does NOT have updated_at (status mutations write completedAt
// instead). `audit_log` has only created_at (immutable).

export const updatedAtFunctionSql = sql`
  CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
  BEGIN
    -- Recursion guard: only bump if caller did not already set it
    IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
      NEW.updated_at = NOW();
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;

export const updatedAtTriggersSql = sql`
  CREATE TRIGGER tr_operator_users_updated_at
    BEFORE UPDATE ON operator_users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

  CREATE TRIGGER tr_servers_updated_at
    BEFORE UPDATE ON servers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

  CREATE TRIGGER tr_tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

export const auditLogImmutableTriggerSql = sql`
  CREATE OR REPLACE FUNCTION reject_audit_modify() RETURNS TRIGGER AS $$
  BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER tr_audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION reject_audit_modify();
`;

/**
 * Aggregated SQL fragment intended to be executed once after the initial
 * `drizzle-kit migrate` run. Phase H1 worker does NOT execute this; the
 * Phase H1b/migration owner emits these statements in a custom migration
 * file (e.g., `drizzle/migrations/0001_triggers.sql`).
 */
export const allTriggersSql = sql`
  ${updatedAtFunctionSql}
  ${updatedAtTriggersSql}
  ${auditLogImmutableTriggerSql}
`;

// ---------------------------------------------------------------------------
// Type exports — see types/db.ts for the canonical re-export surface.
// ---------------------------------------------------------------------------
export type OperatorUser = typeof operatorUsers.$inferSelect;
export type NewOperatorUser = typeof operatorUsers.$inferInsert;
export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = typeof deployments.$inferInsert;
export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
