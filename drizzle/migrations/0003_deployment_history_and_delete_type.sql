-- Add `delete` to the deployment_type enum check (text-column convention —
-- the schema declares enum at the typescript level but Postgres stores
-- as TEXT with no CHECK constraint, so no SQL change is needed for that
-- column's storage. The Zod / drizzle layers enforce the allowed set).

-- deployment_history: point-in-time snapshot table for full rollback.
CREATE TABLE IF NOT EXISTS deployment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deployment_id uuid REFERENCES deployments(id) ON DELETE SET NULL,
  app_version text NOT NULL,
  config_snapshot jsonb NOT NULL,
  config_version integer NOT NULL,
  status text NOT NULL DEFAULT 'success',
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT deployment_history_status_check
    CHECK (status IN ('success', 'rolled_back'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deployment_history_tenant_id
  ON deployment_history (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deployment_history_tenant_created
  ON deployment_history (tenant_id, created_at);
