import { z } from "zod";
import {
  AGENCY_CODES,
  CREDENTIAL_FORMATS,
  DOCUMENT_TYPES,
  PHASE_1_DOCUMENT_TYPES,
  type AgencyCode,
  type CredentialFormat,
  type DocumentType,
} from "./enums";

/**
 * A single row of the config-driven `document_types` registry
 * (migration 004_document_types_registry.sql).
 *
 * `requiresReview` and `isPhase1` are real, queryable flags — not documentation —
 * per the 2026-07-19 addendum: "agency-workspace-api and any Phase 1 demo build
 * can filter on is_phase_1 = true directly."
 */
export interface DocumentTypeDefinition {
  type: DocumentType;
  issuingAgency: AgencyCode;
  /** true = draft -> under_review -> signed -> issued. false = draft -> signed -> issued. */
  requiresReview: boolean;
  /** true = one of the 6 types confirmed for the 90-day RFP milestone. */
  isPhase1: boolean;
  credentialFormat: CredentialFormat;
  /**
   * Number of days a freshly issued document/credential of this type is valid for,
   * or null if the type does not expire on a fixed schedule (e.g. it's a one-time
   * record, or expiry is event-driven rather than time-driven).
   * A non-null value is also the citizen-locker-api gate for self-service renewal
   * (`POST /me/documents/:id/renew` is only enabled when this is non-null).
   */
  defaultValidityDays: number | null;
  /**
   * True only for document types where `documents.is_physical_asset_held` is
   * meaningful (Driver's License, Vehicle Registration) — a linked Traffic Ticket's
   * confiscation event can flip this flag. All other types ignore that column.
   */
  tracksPhysicalAssetCustody: boolean;
  /**
   * True if this agency row is a placeholder FK target (NIR) standing in for an
   * issuing agency that has not yet been onboarded as a real `agencies` row
   * (Ministry of Health / Ministry of Education, per the 2026-07-19 verification note).
   * Must be corrected once the real agency exists — flagged here so no downstream
   * service silently treats the placeholder as confirmed.
   */
  issuingAgencyIsPlaceholder: boolean;
  displayName: string;
}

export const DocumentTypeDefinitionSchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  issuingAgency: z.enum(AGENCY_CODES),
  requiresReview: z.boolean(),
  isPhase1: z.boolean(),
  credentialFormat: z.enum(CREDENTIAL_FORMATS),
  defaultValidityDays: z.number().int().positive().nullable(),
  tracksPhysicalAssetCustody: z.boolean(),
  issuingAgencyIsPlaceholder: z.boolean(),
  displayName: z.string().min(1),
});

/**
 * The full 10-row registry, sourced from the master blueprint's
 * "Document-type registry" table and the 2026-07-19 addendum corrections
 * (Land Title repointed from LRA to LLA; Tax Certificate confirmed for the
 * Phase 1 LRA slot).
 *
 * BIRTH_CERT / HEALTH_RECORD / EDUCATION_RECORD are stubbed against NIR as a
 * placeholder issuing agency (see `issuingAgencyIsPlaceholder`) until MoH/MoE
 * are onboarded — this mirrors migrations 001-004 exactly, it does not
 * silently invent a cleaner answer than the actual repo state.
 */
export const DOCUMENT_TYPE_REGISTRY: Record<DocumentType, DocumentTypeDefinition> = {
  NATIONAL_ID: {
    type: "NATIONAL_ID",
    issuingAgency: "NIR",
    requiresReview: true,
    isPhase1: true,
    credentialFormat: "W3C_VC",
    defaultValidityDays: 3650, // 10 years, placeholder per retention defaults (identity/civil)
    tracksPhysicalAssetCustody: false,
    issuingAgencyIsPlaceholder: false,
    displayName: "National ID",
  },
  DRIVERS_LICENSE: {
    type: "DRIVERS_LICENSE",
    issuingAgency: "MOT",
    requiresReview: true,
    isPhase1: true,
    credentialFormat: "ISO_18013_5_MDOC",
    defaultValidityDays: 1825, // 5 years, typical licence cycle — confirm against MoT once onboarded
    tracksPhysicalAssetCustody: true,
    issuingAgencyIsPlaceholder: false,
    displayName: "Driver's License",
  },
  VEHICLE_REGISTRATION: {
    type: "VEHICLE_REGISTRATION",
    issuingAgency: "MOT",
    requiresReview: true,
    isPhase1: true,
    credentialFormat: "W3C_VC",
    defaultValidityDays: 365,
    tracksPhysicalAssetCustody: true,
    issuingAgencyIsPlaceholder: false,
    displayName: "Vehicle Registration",
  },
  TRAFFIC_TICKET: {
    type: "TRAFFIC_TICKET",
    issuingAgency: "LNP",
    requiresReview: false,
    isPhase1: true,
    credentialFormat: "W3C_VC",
    defaultValidityDays: null, // event-driven (paid / disputed), not a renewable credential
    tracksPhysicalAssetCustody: false,
    issuingAgencyIsPlaceholder: false,
    displayName: "Traffic Ticket",
  },
  BUSINESS_LICENSE: {
    type: "BUSINESS_LICENSE",
    issuingAgency: "LBR",
    requiresReview: false,
    isPhase1: true,
    credentialFormat: "W3C_VC",
    defaultValidityDays: 365,
    tracksPhysicalAssetCustody: false,
    issuingAgencyIsPlaceholder: false,
    displayName: "Business License",
  },
  TAX_CERTIFICATE: {
    type: "TAX_CERTIFICATE",
    issuingAgency: "LRA",
    requiresReview: false,
    isPhase1: true,
    credentialFormat: "W3C_VC",
    defaultValidityDays: 365,
    tracksPhysicalAssetCustody: false,
    issuingAgencyIsPlaceholder: false,
    displayName: "Tax Certificate",
  },
  LAND_TITLE: {
    type: "LAND_TITLE",
    issuingAgency: "LLA", // corrected 2026-07-19: was wrongly pointed at LRA
    requiresReview: true,
    isPhase1: false,
    credentialFormat: "W3C_VC",
    defaultValidityDays: null, // titles don't expire; encumbrance status changes instead
    tracksPhysicalAssetCustody: false,
    issuingAgencyIsPlaceholder: false,
    displayName: "Land Title",
  },
  BIRTH_CERT: {
    type: "BIRTH_CERT",
    issuingAgency: "NIR", // placeholder FK — real agency is MoH/Bureau of Vital Statistics
    requiresReview: true,
    isPhase1: false,
    credentialFormat: "W3C_VC",
    defaultValidityDays: null, // civil record, does not expire
    tracksPhysicalAssetCustody: false,
    issuingAgencyIsPlaceholder: true,
    displayName: "Birth Certificate",
  },
  HEALTH_RECORD: {
    type: "HEALTH_RECORD",
    issuingAgency: "NIR", // placeholder FK — real agency is Ministry of Health
    requiresReview: true,
    isPhase1: false,
    credentialFormat: "W3C_VC",
    defaultValidityDays: null,
    tracksPhysicalAssetCustody: false,
    issuingAgencyIsPlaceholder: true,
    displayName: "Health Record",
  },
  EDUCATION_RECORD: {
    type: "EDUCATION_RECORD",
    issuingAgency: "NIR", // placeholder FK — real agency is Ministry of Education / WAEC
    requiresReview: true,
    isPhase1: false,
    credentialFormat: "W3C_VC",
    defaultValidityDays: null,
    tracksPhysicalAssetCustody: false,
    issuingAgencyIsPlaceholder: true,
    displayName: "Education Record",
  },
};

export function getDocumentTypeDefinition(type: DocumentType): DocumentTypeDefinition {
  return DOCUMENT_TYPE_REGISTRY[type];
}

export function isPhase1DocumentType(
  type: DocumentType,
): type is (typeof PHASE_1_DOCUMENT_TYPES)[number] {
  return (PHASE_1_DOCUMENT_TYPES as readonly string[]).includes(type);
}

/** Types eligible for citizen-initiated renewal via citizen-locker-api (RFP #2). */
export function isRenewable(type: DocumentType): boolean {
  return DOCUMENT_TYPE_REGISTRY[type].defaultValidityDays !== null;
}

/** Every document type currently issued under a placeholder (not-yet-onboarded) agency. */
export function getPlaceholderAgencyDocumentTypes(): DocumentType[] {
  return DOCUMENT_TYPES.filter((t) => DOCUMENT_TYPE_REGISTRY[t].issuingAgencyIsPlaceholder);
}
