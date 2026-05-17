-- S11: audit_log immutability (append-only) enforced at the DB layer.
--
-- The 0000 baseline migration created the table but did NOT install the
-- trigger that schema.ts (`auditLogImmutableTriggerSql`) declares — see
-- S11 task spec. This migration wires that trigger so any UPDATE or
-- DELETE on audit_log raises SQLSTATE P0001 (RAISE EXCEPTION).
--
-- Rationale: KVKK + Doc 17 §11 require operator action trails be
-- tamper-evident. Even an admin with full DB credentials should be
-- unable to silently rewrite history. The trigger is BEFORE so the
-- conflicting row never reaches the heap.
--
-- The function uses CREATE OR REPLACE so it is idempotent. The triggers
-- are wrapped in DROP IF EXISTS guards so re-running the migration on a
-- partially-applied environment converges cleanly.

CREATE OR REPLACE FUNCTION reject_audit_modify() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only — UPDATE/DELETE rejected';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tr_audit_log_no_update ON audit_log;
--> statement-breakpoint
CREATE TRIGGER tr_audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_modify();
--> statement-breakpoint
DROP TRIGGER IF EXISTS tr_audit_log_no_delete ON audit_log;
--> statement-breakpoint
CREATE TRIGGER tr_audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_modify();
