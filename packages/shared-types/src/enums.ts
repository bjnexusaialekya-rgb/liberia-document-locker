/**
 * Core enums shared across all 14 services and 3 client apps.
 * Source of truth: master-blueprint-all-phases-liberia-document-locker.md
 *
 * These are plain TS string-literal unions (not TS `enum`) so that:
 *  - values serialize identically to Postgres text/enum columns
 *  - zod schemas can validate against them directly with z.enum(...)
 *  - no numeric-enum footguns cross service boundaries
 */

// ---------------------------------------------------------------------------
// Document types — all 10 registry entries (blueprint "Document-type registry")
// ---------------------------------------------------------------------------
export const DOCUMENT_TYPES = [
  "NATIONAL_ID",
  "DRIVERS_LICENSE",
  "VEHICLE_REGISTRATION",
  "TRAFFIC_TICKET",
  "BUSINESS_LICENSE",
  "TAX_CERTIFICATE",
  "LAND_TITLE",
  "BIRTH_CERT",
  "HEALTH_RECORD",
  "EDUCATION_RECORD",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** The 6 types confirmed in scope for the RFP's 90-day first milestone (locked 2026-07-19). */
export const PHASE_1_DOCUMENT_TYPES = [
  "NATIONAL_ID",
  "DRIVERS_LICENSE",
  "VEHICLE_REGISTRATION",
  "TRAFFIC_TICKET",
  "BUSINESS_LICENSE",
  "TAX_CERTIFICATE",
] as const;
export type Phase1DocumentType = (typeof PHASE_1_DOCUMENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Agencies — 6 seeded rows per migration 002_agencies_users_roles.sql
// ---------------------------------------------------------------------------
export const AGENCY_CODES = ["NIR", "MOT", "LNP", "LBR", "LRA", "LLA"] as const;
export type AgencyCode = (typeof AGENCY_CODES)[number];

// ---------------------------------------------------------------------------
// Credential formats — the standards envelope each document type is issued in
// ---------------------------------------------------------------------------
export const CREDENTIAL_FORMATS = ["W3C_VC", "ISO_18013_5_MDOC"] as const;
export type CredentialFormat = (typeof CREDENTIAL_FORMATS)[number];

// ---------------------------------------------------------------------------
// User types — the 4 confirmed types covering every account on the platform
// ---------------------------------------------------------------------------
export const USER_TYPES = [
  "CITIZEN",
  "AGENCY_STAFF",
  "AGENCY_SUPERVISOR",
  "PLATFORM_ADMIN",
] as const;
export type UserType = (typeof USER_TYPES)[number];

/**
 * Functional roles layered on top of UserType via the ABAC join (user_roles).
 * Separation-of-duties matrix (RFP #1 / Phase 1 test gate): issuer ≠ approver ≠ auditor —
 * a single user must never hold more than one of these three on the same agency.
 */
export const ROLES = [
  "ISSUER",
  "APPROVER",
  "AUDITOR",
  "AGENCY_SUPERVISOR",
  "PLATFORM_ADMIN",
] as const;
export type Role = (typeof ROLES)[number];

/** Roles that are mutually exclusive for the same user within the same agency. */
export const SEPARATION_OF_DUTIES_ROLES = ["ISSUER", "APPROVER", "AUDITOR"] as const;
export type SeparationOfDutiesRole = (typeof SEPARATION_OF_DUTIES_ROLES)[number];

// ---------------------------------------------------------------------------
// Document lifecycle status (RFP #5) — `expired` is always computed, never stored
// ---------------------------------------------------------------------------
export const DOCUMENT_STATUSES = ["active", "suspended", "revoked", "archived"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Issuance workflow stage — distinct from DocumentStatus, tracks the draft->issued pipeline. */
export const ISSUANCE_STATUSES = [
  "draft",
  "under_review",
  "signed",
  "issued",
] as const;
export type IssuanceStatus = (typeof ISSUANCE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Consent state machine (RFP #6): pending_otp -> active -> (expired | revoked)
// ---------------------------------------------------------------------------
export const CONSENT_STATES = ["pending_otp", "active", "expired", "revoked"] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

// ---------------------------------------------------------------------------
// Verification result (RFP #7) — never the full document, minimal fields only
// ---------------------------------------------------------------------------
export const VERIFICATION_STATUSES = ["verified", "not_verified"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Sensitivity tiers — packages/kms Vault Transit key-per-tier scheme (RFP #11)
// ---------------------------------------------------------------------------
export const KMS_KEY_TIERS = ["pii-standard", "pii-biometric", "payment-data"] as const;
export type KmsKeyTier = (typeof KMS_KEY_TIERS)[number];

// ---------------------------------------------------------------------------
// Payment status — payment-engine / IIPS via pm4ml (RFP #9)
// ---------------------------------------------------------------------------
export const PAYMENT_STATUSES = [
  "pending",
  "completed",
  "failed",
  "reconciling",
  "refunded",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Currency — Liberia runs a de facto dual-currency economy: Liberian dollar
// (LRD) is legal tender, but USD circulates and is routinely used for
// government fees (the blueprint's own Traffic Ticket schema confirms real
// fine amounts are denominated in USD). IIPS (the Central Bank of Liberia's
// Mojaloop-based payment rail) settles in both. No other currency is a real
// option on this platform, so the type is closed to these two rather than
// left open to any ISO 4217 code.
// ---------------------------------------------------------------------------
export const CURRENCY_CODES = ["LRD", "USD"] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];
