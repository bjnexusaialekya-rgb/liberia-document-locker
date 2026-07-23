-- 003_rls_foundation.sql
-- The locker_app runtime role, session-context GUCs + helper functions, and
-- RLS policies on users/user_roles/agencies/roles.
--
-- IMPORTANT: this migration must be run by a privileged/owner role (the same
-- one that owns the tables from 002), never by locker_app itself — table
-- owners bypass RLS by default, which is exactly why the app must connect
-- as locker_app at runtime and never as the migration/owner role.

-- ---------------------------------------------------------------------------
-- locker_app runtime role
-- ---------------------------------------------------------------------------
-- No password is set here — that's deliberate. Set it out-of-band via
-- `ALTER ROLE locker_app WITH PASSWORD '...'` from a secrets-managed script
-- (Vault / AWS Secrets Manager), the same pattern already used for Trestle's
-- Stripe webhook secret. Never commit a real credential in a migration file.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'locker_app') THEN
    CREATE ROLE locker_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO locker_app;

-- SELECT/INSERT/UPDATE only — DELETE is deliberately never granted. Nothing
-- in this platform is ever hard-deleted (RFP #5: documents move through a
-- status lifecycle, never disappear; the same principle is applied here to
-- every table locker_app touches, not just documents).
GRANT SELECT, INSERT, UPDATE ON agencies, users, roles, user_roles, schema_migrations TO locker_app;

-- Belt-and-suspenders: explicitly revoke DELETE even though it was never
-- granted, so this migration is also the single place that documents and
-- enforces the "no DELETE, ever" rule, rather than relying on it being an
-- absence rather than a decision.
REVOKE DELETE ON agencies, users, roles, user_roles, schema_migrations FROM locker_app;

-- ---------------------------------------------------------------------------
-- Session-context GUCs
-- ---------------------------------------------------------------------------
-- Every service sets these three per-connection/per-transaction (via
-- src/index.ts's setSessionContext(), using SET LOCAL so they never leak
-- across pooled connections) immediately after authenticating a request.
-- RLS policies below read them through these SECURITY DEFINER-free helper
-- functions rather than calling current_setting() directly in every policy,
-- so there's one place to fix if the GUC naming ever changes.
--
--   app.current_user_id    — uuid of the authenticated principal
--   app.current_user_type  — one of the 4 USER_TYPES, or 'SERVICE' for
--                             service-to-service calls authenticated via mTLS
--                             (packages/mtls) rather than a human session
--   app.current_agency_id  — uuid, null for CITIZEN/PLATFORM_ADMIN/SERVICE
--
-- The `true` second argument to current_setting() makes it return NULL
-- instead of raising when the GUC was never set (e.g. a raw psql session),
-- which fails every RLS check closed rather than erroring open.
CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_current_user_type()
RETURNS text AS $$
  SELECT NULLIF(current_setting('app.current_user_type', true), '');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_current_agency_id()
RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_agency_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- agencies — reference data. Readable by anyone with an active session
-- (every service needs to resolve agency names/codes); writable only by
-- platform_admin.
-- ---------------------------------------------------------------------------
ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;

CREATE POLICY agencies_select ON agencies
  FOR SELECT USING (app_current_user_id() IS NOT NULL);

CREATE POLICY agencies_write ON agencies
  FOR INSERT WITH CHECK (app_current_user_type() = 'PLATFORM_ADMIN');

CREATE POLICY agencies_update ON agencies
  FOR UPDATE USING (app_current_user_type() = 'PLATFORM_ADMIN')
  WITH CHECK (app_current_user_type() = 'PLATFORM_ADMIN');

-- ---------------------------------------------------------------------------
-- roles — reference data, same shape as agencies.
-- ---------------------------------------------------------------------------
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY roles_select ON roles
  FOR SELECT USING (app_current_user_id() IS NOT NULL);

CREATE POLICY roles_write ON roles
  FOR INSERT WITH CHECK (app_current_user_type() = 'PLATFORM_ADMIN');

CREATE POLICY roles_update ON roles
  FOR UPDATE USING (app_current_user_type() = 'PLATFORM_ADMIN')
  WITH CHECK (app_current_user_type() = 'PLATFORM_ADMIN');

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- A user always sees their own row. Agency staff/supervisors see everyone in
-- their own agency (needed to look up citizens applying at their counter,
-- and co-workers). platform_admin sees everyone.
CREATE POLICY users_select ON users
  FOR SELECT USING (
    id = app_current_user_id()
    OR app_current_user_type() = 'PLATFORM_ADMIN'
    OR (
      app_current_user_type() IN ('AGENCY_STAFF', 'AGENCY_SUPERVISOR')
      AND agency_id = app_current_agency_id()
    )
  );

-- NOTE (flagged, not silently resolved): citizen self-registration is
-- deliberately NOT covered by an INSERT policy here. A brand-new citizen has
-- no session yet — app.current_user_id is null at the point their row needs
-- to be created — so no RLS policy keyed on "who is the caller" can cover
-- that first insert. auth (Session — not yet built) will need its own
-- narrowly-scoped path for this, most likely a SECURITY DEFINER function or
-- a short-lived elevated role used only for the registration endpoint, not
-- locker_app's general INSERT grant. This migration only covers the two
-- cases that DO have an authenticated actor: an admin/supervisor creating an
-- agency-staff account, and a user updating their own profile.
CREATE POLICY users_insert_by_admin_or_supervisor ON users
  FOR INSERT WITH CHECK (
    app_current_user_type() = 'PLATFORM_ADMIN'
    OR (
      app_current_user_type() = 'AGENCY_SUPERVISOR'
      AND agency_id = app_current_agency_id()
    )
  );

CREATE POLICY users_update ON users
  FOR UPDATE USING (
    id = app_current_user_id()
    OR app_current_user_type() = 'PLATFORM_ADMIN'
    OR (
      app_current_user_type() = 'AGENCY_SUPERVISOR'
      AND agency_id = app_current_agency_id()
    )
  )
  WITH CHECK (
    id = app_current_user_id()
    OR app_current_user_type() = 'PLATFORM_ADMIN'
    OR (
      app_current_user_type() = 'AGENCY_SUPERVISOR'
      AND agency_id = app_current_agency_id()
    )
  );

-- ---------------------------------------------------------------------------
-- user_roles
-- ---------------------------------------------------------------------------
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_roles_select ON user_roles
  FOR SELECT USING (
    user_id = app_current_user_id()
    OR app_current_user_type() = 'PLATFORM_ADMIN'
    OR (
      app_current_user_type() IN ('AGENCY_STAFF', 'AGENCY_SUPERVISOR')
      AND agency_id = app_current_agency_id()
    )
  );

-- Only platform_admin and the granting agency's own supervisor can grant
-- roles, and only within their own agency. No UPDATE policy is defined:
-- role grants are immutable once created (matches "nothing ever hard-deleted"
-- — a mis-granted role should be handled by the separation-of-duties trigger
-- rejecting the bad grant in the first place, not by editing it after).
CREATE POLICY user_roles_insert ON user_roles
  FOR INSERT WITH CHECK (
    app_current_user_type() = 'PLATFORM_ADMIN'
    OR (
      app_current_user_type() = 'AGENCY_SUPERVISOR'
      AND agency_id = app_current_agency_id()
    )
  );
