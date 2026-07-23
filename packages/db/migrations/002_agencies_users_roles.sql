-- 002_agencies_users_roles.sql
-- Agencies, users (all 4 user_types), the roles reference table, and the
-- user_roles ABAC join. Seed data mirrors @liberia-locker/shared-types'
-- AGENCY_REGISTRY and enums.ts exactly (AGENCY_CODES, USER_TYPES, ROLES) —
-- if either ever needs to change, change shared-types first and update this
-- migration to match, never the other way around.

-- ---------------------------------------------------------------------------
-- agencies
-- ---------------------------------------------------------------------------
CREATE TABLE agencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE
              CHECK (code IN ('NIR', 'MOT', 'LNP', 'LBR', 'LRA', 'LLA')),
  name        text NOT NULL,
  full_name   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 6 seeded rows (source: master blueprint's document-type registry table +
-- 2026-07-19 addendum correcting Land Title from LRA to LLA). NIR doubles as
-- the placeholder issuing-agency FK target for BIRTH_CERT / HEALTH_RECORD /
-- EDUCATION_RECORD until Ministry of Health / Ministry of Education are
-- onboarded as real agency rows — see migration 004 and shared-types'
-- `issuingAgencyIsPlaceholder` flag for where that's tracked and surfaced.
INSERT INTO agencies (code, name, full_name) VALUES
  ('NIR', 'NIR', 'National Identification Registry'),
  ('MOT', 'MOT', 'Ministry of Transport'),
  ('LNP', 'LNP', 'Liberia National Police'),
  ('LBR', 'LBR', 'Liberia Business Registry'),
  ('LRA', 'LRA', 'Liberia Revenue Authority'),
  ('LLA', 'LLA', 'Liberia Land Authority');

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- national_id_number and phone_number are nullable: agency staff/admin
-- accounts authenticate via agency SSO (not NIR), and not every citizen
-- account is guaranteed a captured phone number at creation time.
-- The +231 E.164 format check mirrors shared-types' LIBERIA_PHONE_REGEX
-- exactly — keep both in sync if Liberia's numbering plan ever changes.
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_type           text NOT NULL
                      CHECK (user_type IN ('CITIZEN', 'AGENCY_STAFF', 'AGENCY_SUPERVISOR', 'PLATFORM_ADMIN')),
  full_name           text NOT NULL,
  national_id_number  citext,
  agency_id           uuid REFERENCES agencies(id),
  phone_number        text CHECK (phone_number ~ '^\+231\d{8,9}$'),
  email               citext,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Mirrors the User interface comment in shared-types/users.ts: agency_id is
  -- null for CITIZEN/PLATFORM_ADMIN, required for AGENCY_STAFF/AGENCY_SUPERVISOR.
  CONSTRAINT agency_id_required_for_agency_accounts CHECK (
    (user_type IN ('AGENCY_STAFF', 'AGENCY_SUPERVISOR') AND agency_id IS NOT NULL)
    OR (user_type IN ('CITIZEN', 'PLATFORM_ADMIN') AND agency_id IS NULL)
  )
);

CREATE UNIQUE INDEX users_national_id_number_key ON users (national_id_number) WHERE national_id_number IS NOT NULL;
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE email IS NOT NULL;
CREATE INDEX users_agency_id_idx ON users (agency_id) WHERE agency_id IS NOT NULL;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- roles — reference table, not just an app-level enum, so user_roles.role
-- can FK against real rows rather than a bare CHECK constraint.
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  role         text PRIMARY KEY
               CHECK (role IN ('ISSUER', 'APPROVER', 'AUDITOR', 'AGENCY_SUPERVISOR', 'PLATFORM_ADMIN')),
  description  text NOT NULL
);

INSERT INTO roles (role, description) VALUES
  ('ISSUER',            'Can create and issue documents/credentials within their agency.'),
  ('APPROVER',          'Reviews and approves documents that require a second-reviewer step (requires_review = true).'),
  ('AUDITOR',           'Read-only access to audit trails and issuance history within their agency.'),
  ('AGENCY_SUPERVISOR', 'Agency-level management role: grants/revokes ISSUER/APPROVER/AUDITOR within their own agency.'),
  ('PLATFORM_ADMIN',    'Platform-wide administrative role, not scoped to a single agency.');

-- ---------------------------------------------------------------------------
-- user_roles — ABAC join: a role grant is always scoped to one agency.
-- ---------------------------------------------------------------------------
CREATE TABLE user_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL REFERENCES roles(role),
  agency_id   uuid NOT NULL REFERENCES agencies(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid NOT NULL REFERENCES users(id),

  UNIQUE (user_id, role, agency_id)
);

CREATE INDEX user_roles_user_id_idx ON user_roles (user_id);
CREATE INDEX user_roles_agency_id_idx ON user_roles (agency_id);

-- ---------------------------------------------------------------------------
-- Separation-of-duties enforcement (Phase 1 test gate, mirrors
-- shared-types' violatesSeparationOfDuties predicate at the DB layer too —
-- app-layer and DB-layer both reject independently, per the blueprint's
-- "both layers independently verified" requirement). A single user must
-- never hold more than one of ISSUER / APPROVER / AUDITOR on the same
-- agency at the same time.
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
  ) THEN
    RAISE EXCEPTION
      'separation-of-duties violation: user % already holds a conflicting role in agency %',
      NEW.user_id, NEW.agency_id
      USING ERRCODE = '23514'; -- reuse check_violation so callers can catch it the same way as other constraint failures
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_roles_enforce_separation_of_duties
BEFORE INSERT OR UPDATE ON user_roles
FOR EACH ROW EXECUTE FUNCTION enforce_separation_of_duties();
