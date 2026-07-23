-- 006_role_revocation.sql
-- Adds revocation to user_roles. 002's comment said "no UPDATE policy is
-- defined: role grants are immutable once created" — correct for preventing
-- edits to a grant, but it also meant there was no way to revoke a role at
-- all, at the DB or RLS layer. Revocation is an UPDATE setting
-- revoked_at/revoked_by, never a DELETE — consistent with locker_app's
-- no-DELETE-grant rule enforced everywhere else in this schema.

ALTER TABLE user_roles
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid REFERENCES users(id);

-- ---------------------------------------------------------------------------
-- RLS: an UPDATE policy scoped identically to the existing INSERT policy
-- (platform_admin, or agency_supervisor within their own agency). Before this
-- migration nobody could revoke a role even at the app layer — 003 defined
-- SELECT and INSERT on user_roles but no UPDATE policy at all.
-- ---------------------------------------------------------------------------
CREATE POLICY user_roles_update ON user_roles
  FOR UPDATE USING (
    app_current_user_type() = 'PLATFORM_ADMIN'
    OR (
      app_current_user_type() = 'AGENCY_SUPERVISOR'
      AND agency_id = app_current_agency_id()
    )
  )
  WITH CHECK (
    app_current_user_type() = 'PLATFORM_ADMIN'
    OR (
      app_current_user_type() = 'AGENCY_SUPERVISOR'
      AND agency_id = app_current_agency_id()
    )
  );

-- Only revoked_at/revoked_by may change via this path — a revocation update
-- should never be able to rewrite user_id/role/agency_id/granted_by/granted_at
-- into a different grant. RLS's WITH CHECK alone can't express "these specific
-- columns are immutable," so it's enforced here instead of left to app-layer trust.
CREATE OR REPLACE FUNCTION enforce_user_roles_update_is_revocation_only()
RETURNS trigger AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.agency_id IS DISTINCT FROM OLD.agency_id
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
  THEN
    RAISE EXCEPTION
      'user_roles rows are append-only except for revocation: only revoked_at/revoked_by may change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_roles_update_is_revocation_only
BEFORE UPDATE ON user_roles
FOR EACH ROW EXECUTE FUNCTION enforce_user_roles_update_is_revocation_only();

-- ---------------------------------------------------------------------------
-- 002's enforce_separation_of_duties() checked for ANY conflicting grant,
-- active or not — a revoked ISSUER grant would still block a new APPROVER
-- grant for the same user/agency. Redefine it to only count active
-- (revoked_at IS NULL) grants as conflicts. CREATE OR REPLACE keeps the
-- existing trigger binding from 002; no need to re-create the trigger itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_separation_of_duties()
RETURNS trigger AS $$
BEGIN
  IF NEW.role NOT IN ('ISSUER', 'APPROVER', 'AUDITOR') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = NEW.user_id
      AND agency_id = NEW.agency_id
      AND role IN ('ISSUER', 'APPROVER', 'AUDITOR')
      AND role <> NEW.role
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'separation-of-duties violation: user % already holds a conflicting active role in agency %',
      NEW.user_id, NEW.agency_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Any future "does this user hold role X" query anywhere in the platform
-- must add WHERE revoked_at IS NULL — otherwise a revoked grant still counts
-- as active. This partial index makes that the fast path, not just the
-- correct one.
-- ---------------------------------------------------------------------------
CREATE INDEX user_roles_active_lookup_idx ON user_roles (user_id, agency_id, role)
  WHERE revoked_at IS NULL;
