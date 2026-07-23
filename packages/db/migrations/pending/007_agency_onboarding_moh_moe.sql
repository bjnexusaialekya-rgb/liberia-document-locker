-- migrations/pending/007_agency_onboarding_moh_moe.sql
--
-- NOT auto-applied: this file lives in migrations/pending/, outside the
-- migrations/ directory src/migrate.ts scans (loadMigrations only reads the
-- passed-in dir, non-recursively) — `npm run migrate` will not pick this up.
-- This is deliberate "stub and flag," not an oversight: BIRTH_CERT,
-- HEALTH_RECORD, and EDUCATION_RECORD are stubbed against NIR as a
-- placeholder issuing agency (004_document_types_registry.sql) because MOH/
-- MOE onboarding is a business/contract question for the client, not a
-- technical gap in this schema.
--
-- Move this file into migrations/ (as the next-numbered migration at that
-- time — do not backdate it to 007 if other migrations have shipped in the
-- meantime) once:
--   1. The client has confirmed Ministry of Health and Ministry of Education
--      as onboarding agencies, AND
--   2. For HEALTH_RECORD specifically: note that onboarding the MOH agency
--      row alone does not make HEALTH_RECORD buildable. MoH's EMR/EHR
--      system is still an open 2026 procurement notice with nothing live to
--      integrate against — that's a separate blocker from "which agency
--      owns this," and isn't resolved by this migration. Track it in
--      document-issuance's session prompt, not here.

INSERT INTO agencies (code, name, full_name) VALUES
  ('MOH', 'MOH', 'Ministry of Health'),
  ('MOE', 'MOE', 'Ministry of Education');

-- agencies.code's CHECK constraint (002_agencies_users_roles.sql) currently
-- only allows ('NIR','MOT','LNP','LBR','LRA','LLA') — the INSERT above will
-- fail until that constraint is widened. Included here as an explicit
-- reminder rather than silently worked around; run this first:
--   ALTER TABLE agencies DROP CONSTRAINT agencies_code_check;
--   ALTER TABLE agencies ADD CONSTRAINT agencies_code_check
--     CHECK (code IN ('NIR','MOT','LNP','LBR','LRA','LLA','MOH','MOE'));

UPDATE document_types
SET issuing_agency = 'MOH', issuing_agency_is_placeholder = false
WHERE type IN ('BIRTH_CERT', 'HEALTH_RECORD');

UPDATE document_types
SET issuing_agency = 'MOE', issuing_agency_is_placeholder = false
WHERE type = 'EDUCATION_RECORD';

-- issuing_agency_is_placeholder flips to false for all three above because
-- the *agency* is now confirmed real, not a stand-in — that flag only ever
-- tracked "is this FK pointing at NIR as a stub," not "is this document type
-- fully buildable." HEALTH_RECORD's separate EMR/EHR blocker (see header)
-- still applies after this migration runs; document-issuance must not treat
-- issuing_agency_is_placeholder = false as "ready to build" for that type
-- without checking the session prompt's open-item note too.
