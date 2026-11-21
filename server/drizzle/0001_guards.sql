-- Database-level guards: rules that must hold even if application code has a bug.

-- 1) The audit log is append-only. Nobody (including the application's own DB user) can rewrite history
--    through UPDATE/DELETE. (TRUNCATE is blocked too.)
CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();--> statement-breakpoint

-- 2) A cancelled certificate can never become valid again, and identity fields never change.
CREATE FUNCTION certificates_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'a cancelled certificate cannot be reinstated' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.number <> OLD.number OR NEW.candidate_id <> OLD.candidate_id OR NEW.batch_id <> OLD.batch_id THEN
    RAISE EXCEPTION 'certificate identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER certificates_guard_trg BEFORE UPDATE ON certificates
  FOR EACH ROW EXECUTE FUNCTION certificates_guard();--> statement-breakpoint

-- 3) Certificates are never deleted.
CREATE FUNCTION certificates_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'certificates cannot be deleted; cancel them instead' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER certificates_no_delete_trg BEFORE DELETE ON certificates
  FOR EACH ROW EXECUTE FUNCTION certificates_no_delete();
