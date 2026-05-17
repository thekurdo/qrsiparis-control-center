CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"metadata" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"deployment_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"app_version" text NOT NULL,
	"config_version" integer,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_seconds" integer,
	"triggered_by_user_id" uuid,
	"trigger_reason" text,
	"log" text,
	"error_message" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"two_factor_secret" text,
	"two_factor_backup_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"last_login_ip" text,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"failed_login_locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_operator_users_backup_codes_count" CHECK ("operator_users"."two_factor_enabled" = false OR array_length("operator_users"."two_factor_backup_codes", 1) = 4)
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'hostinger' NOT NULL,
	"public_ip" text NOT NULL,
	"public_hostname" text,
	"ssh_port" integer DEFAULT 22 NOT NULL,
	"ssh_user" text DEFAULT 'root' NOT NULL,
	"ssh_private_key_encrypted" text,
	"total_cpu_cores" integer NOT NULL,
	"total_ram_mb" integer NOT NULL,
	"total_disk_gb" integer NOT NULL,
	"cpu_per_tenant_centi" integer DEFAULT 50 NOT NULL,
	"ram_per_tenant_mb" integer DEFAULT 768 NOT NULL,
	"max_tenants_theoretical" integer DEFAULT 20 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"last_health_status" text,
	"cpu_usage_pct" integer,
	"ram_usage_pct" integer,
	"disk_usage_pct" integer,
	"uptime_days" integer,
	"coolify_url" text,
	"coolify_api_token_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_servers_cpu_per_tenant_centi_bounds" CHECK ("servers"."cpu_per_tenant_centi" >= 1 AND "servers"."cpu_per_tenant_centi" <= 1000),
	CONSTRAINT "ck_servers_ram_per_tenant_mb_bounds" CHECK ("servers"."ram_per_tenant_mb" >= 128 AND "servers"."ram_per_tenant_mb" <= 4096)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_code" text NOT NULL,
	"restaurant_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"contact_phone" text NOT NULL,
	"contact_email" text,
	"address" text,
	"city" text NOT NULL,
	"tier" text DEFAULT 'baslangic' NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"contract_start_date" timestamp with time zone NOT NULL,
	"contract_end_date" timestamp with time zone NOT NULL,
	"monthly_fee_kurus" bigint NOT NULL,
	"sales_partner" text,
	"commission_rate_percent" integer DEFAULT 0 NOT NULL,
	"server_id_ref" uuid,
	"domain" text NOT NULL,
	"container_name" text,
	"container_status" text DEFAULT 'not_deployed' NOT NULL,
	"config_snapshot" jsonb,
	"config_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'onboarding' NOT NULL,
	"internal_notes" text,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_tenants_short_code_format" CHECK ("tenants"."short_code" ~ '^[a-z0-9-]+$' AND char_length("tenants"."short_code") BETWEEN 3 AND 50),
	CONSTRAINT "ck_tenants_commission_rate_bounds" CHECK ("tenants"."commission_rate_percent" >= 0 AND "tenants"."commission_rate_percent" <= 100)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_operator_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."operator_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_triggered_by_user_id_operator_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."operator_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_server_id_ref_servers_id_fk" FOREIGN KEY ("server_id_ref") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_log_user_created" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_log_entity" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_created_at" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_deployments_tenant_id" ON "deployments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_deployments_status" ON "deployments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_deployments_created_at" ON "deployments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_deployments_tenant_status_created" ON "deployments" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_operator_users_username" ON "operator_users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_operator_users_email" ON "operator_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_operator_users_is_active" ON "operator_users" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_servers_name" ON "servers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_servers_status" ON "servers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tenants_short_code" ON "tenants" USING btree ("short_code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tenants_domain" ON "tenants" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "idx_tenants_status" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tenants_server_id_ref" ON "tenants" USING btree ("server_id_ref");