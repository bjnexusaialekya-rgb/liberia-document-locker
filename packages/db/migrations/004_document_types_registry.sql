-- 004_document_types_registry.sql
-- Config-driven document_types registry: all 10 registry entries from the
-- master blueprint's "Document-type registry" table, seeded to match
-- @liberia-locker/shared-types' DOCUMENT_TYPE_REGISTRY constant field for
-- field. If the two ever drift, shared-types is the source of truth — fix
-- this migration to match it, not the other way around.
--
-- field_schema is real, sourced field data from the blueprint's "Known real
-- fields (sourced)" column, not placeholder data — see per-row comments for
-- which fields are still pending agency confirmation. HEALTH_RECORD ships an
-- empty field_schema deliberately: the blueprint is explicit that no
-- existing national schema or system exists yet for it.

CREATE TABLE document_types (
  type                          text PRIMARY KEY
                                 CHECK (type IN (
                                   'NATIONAL_ID', 'DRIVERS_LICENSE', 'VEHICLE_REGISTRATION',
                                   'TRAFFIC_TICKET', 'BUSINESS_LICENSE', 'TAX_CERTIFICATE',
                                   'LAND_TITLE', 'BIRTH_CERT', 'HEALTH_RECORD', 'EDUCATION_RECORD'
                                 )),
  issuing_agency                text NOT NULL REFERENCES agencies(code),
  requires_review                boolean NOT NULL,
  is_phase1                     boolean NOT NULL,
  credential_format             text NOT NULL CHECK (credential_format IN ('W3C_VC', 'ISO_18013_5_MDOC')),
  -- null = does not expire on a fixed schedule (event-driven, or a
  -- non-renewable civil record). Non-null is also citizen-locker-api's gate
  -- for whether self-service renewal is offered for this type.
  default_validity_days         integer CHECK (default_validity_days IS NULL OR default_validity_days > 0),
  -- Only meaningful for DRIVERS_LICENSE / VEHICLE_REGISTRATION — flips via
  -- documents.is_physical_asset_held (Session 6) when a linked Traffic
  -- Ticket confiscation event occurs.
  tracks_physical_asset_custody boolean NOT NULL DEFAULT false,
  -- true only for the 3 types currently stubbed against NIR as a
  -- placeholder issuing agency (Ministry of Health / Ministry of Education
  -- have no dedicated agency row yet). Every service consuming this table
  -- must check this flag before treating issuing_agency as confirmed.
  issuing_agency_is_placeholder boolean NOT NULL DEFAULT false,
  display_name                  text NOT NULL,
  field_schema                  jsonb NOT NULL DEFAULT '[]'::jsonb
);

INSERT INTO document_types
  (type, issuing_agency, requires_review, is_phase1, credential_format, default_validity_days, tracks_physical_asset_custody, issuing_agency_is_placeholder, display_name, field_schema)
VALUES
  -- Core fields confirmed by law (Executive Order 147); full schema still gated on NIR/OSD access.
  ('NATIONAL_ID', 'NIR', true, true, 'W3C_VC', 3650, false, false, 'National ID',
    '["nin", "full_name", "date_of_birth", "photo", "biometric_reference", "issue_date", "expiry_date"]'::jsonb),

  -- Structure standard (ISO 18013-5 mDoc); exact license-class codes still need MoT confirmation.
  ('DRIVERS_LICENSE', 'MOT', true, true, 'ISO_18013_5_MDOC', 1825, true, false, 'Driver''s License',
    '["license_number", "license_class", "full_name", "date_of_birth", "photo", "issue_date", "expiry_date"]'::jsonb),

  -- Plate format confirmed publicly (6x12in, prefix A/B/C private, CD+number diplomatic); ownership/VIN schema still needs MoT confirmation.
  ('VEHICLE_REGISTRATION', 'MOT', true, true, 'W3C_VC', 365, true, false, 'Vehicle Registration',
    '["plate_number", "vin", "owner_name", "make", "model", "registration_date"]'::jsonb),

  -- Sourced from a real adjudicated LNP case. License is not returned until the fine is paid — see documents.is_physical_asset_held (Session 6).
  ('TRAFFIC_TICKET', 'LNP', false, true, 'W3C_VC', NULL, false, false, 'Traffic Ticket',
    '["plate_number", "vin", "violation_code", "fine_amount_usd", "payment_deadline", "issuing_officer", "traffic_court_reference"]'::jsonb),

  -- Sourced from real LBR forms (RF-001, Forms A/B/E/F). One of the strongest-documented schemas in the registry.
  ('BUSINESS_LICENSE', 'LBR', false, true, 'W3C_VC', 365, false, false, 'Business License',
    '["rf001_registration_number", "entity_name", "incorporation_date", "tin", "shareholder_incorporator_data", "registered_agent_reference"]'::jsonb),

  -- LRA's TIN issuance process is publicly documented and straightforward to map.
  ('TAX_CERTIFICATE', 'LRA', false, true, 'W3C_VC', 365, false, false, 'Tax Certificate',
    '["tin", "taxpayer_name", "tax_period", "certificate_of_good_standing_status"]'::jsonb),

  -- Phase 2+ candidate, not part of the 90-day commitment. Corrected 2026-07-19: agency is LLA, not LRA. Titles don't expire; encumbrance status changes instead.
  ('LAND_TITLE', 'LLA', true, false, 'W3C_VC', NULL, false, false, 'Land Title',
    '["deed_title_number", "owner_name", "property_description", "real_estate_tax_receipt_reference", "encumbrance_status"]'::jsonb),

  -- Real form confirmed ("Section 1: Patient Information"; Birth and Death Registration Act of 1971). Issuing agency is a placeholder: real agency is MoH/Bureau of Vital Statistics, not yet onboarded.
  ('BIRTH_CERT', 'NIR', true, false, 'W3C_VC', NULL, false, true, 'Birth Certificate',
    '["full_name", "date_of_birth", "place_of_birth", "parent_names", "registration_number"]'::jsonb),

  -- No existing national schema or system as of this migration (MoH has an open 2026 procurement notice for an EMR/EHR system). Deliberately empty field_schema, not a placeholder guess.
  ('HEALTH_RECORD', 'NIR', true, false, 'W3C_VC', NULL, false, true, 'Health Record',
    '[]'::jsonb),

  -- Strongest integration opportunity in the registry (WAEC DigiCert already live, 2026). Issuing agency is a placeholder: real agency is Ministry of Education / WAEC.
  ('EDUCATION_RECORD', 'NIR', true, false, 'W3C_VC', NULL, false, true, 'Education Record',
    '["full_name", "exam_number", "subjects_grades", "exam_year", "certificate_type"]'::jsonb);

-- ---------------------------------------------------------------------------
-- RLS — readable by any authenticated session (every service needs to
-- resolve document-type config), writable only by platform_admin. This is
-- the "admin-editable, not hardcoded" surface the blueprint's Phase 4 admin
-- UI item points at for fee/retention-adjacent config changes.
-- ---------------------------------------------------------------------------
ALTER TABLE document_types ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON document_types TO locker_app;
REVOKE DELETE ON document_types FROM locker_app;

CREATE POLICY document_types_select ON document_types
  FOR SELECT USING (app_current_user_id() IS NOT NULL);

CREATE POLICY document_types_write ON document_types
  FOR INSERT WITH CHECK (app_current_user_type() = 'PLATFORM_ADMIN');

CREATE POLICY document_types_update ON document_types
  FOR UPDATE USING (app_current_user_type() = 'PLATFORM_ADMIN')
  WITH CHECK (app_current_user_type() = 'PLATFORM_ADMIN');
