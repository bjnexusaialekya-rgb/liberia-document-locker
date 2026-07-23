import { z } from "zod";
import {
  CURRENCY_CODES,
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  type CurrencyCode,
  type DocumentStatus,
  type DocumentType,
} from "../enums";

/** Mirrors `documents` — the current-pointer row (RFP #5). Never mutated in place. */
export interface DocumentRecord {
  id: string; // UUID
  citizenId: string; // UUID
  agencyId: string; // UUID
  documentType: DocumentType;
  status: DocumentStatus;
  currentVersionId: string; // UUID -> document_versions.id
  /** Relevant only to DRIVERS_LICENSE / VEHICLE_REGISTRATION; other types ignore this. */
  isPhysicalAssetHeld: boolean;
  issuedAt: string; // ISO 8601
  expiryDate: string | null; // ISO 8601 — `expired` status is computed from this, never stored
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export const DocumentRecordSchema = z.object({
  id: z.string().uuid(),
  citizenId: z.string().uuid(),
  agencyId: z.string().uuid(),
  documentType: z.enum(DOCUMENT_TYPES),
  status: z.enum(DOCUMENT_STATUSES),
  currentVersionId: z.string().uuid(),
  isPhysicalAssetHeld: z.boolean(),
  issuedAt: z.string().datetime(),
  expiryDate: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** Mirrors `document_versions` — the append-only history (RFP #5). */
export interface DocumentVersion {
  id: string; // UUID
  documentId: string; // UUID
  versionNumber: number;
  payloadHash: string; // sha256 hex of the encrypted credential payload
  issuedBy: string; // UUID of the issuing staff/service principal
  issuedAt: string; // ISO 8601
  supersededAt: string | null; // ISO 8601 — null for the current version
}

export const DocumentVersionSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  versionNumber: z.number().int().min(1),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/i),
  issuedBy: z.string().uuid(),
  issuedAt: z.string().datetime(),
  supersededAt: z.string().datetime().nullable(),
});

/** document-issuance (Session 8): create a new document for a citizen. */
export interface IssueDocumentRequest {
  citizenId: string;
  documentType: DocumentType;
  /** Type-specific field payload — validated against that document type's field_schema at runtime. */
  fields: Record<string, unknown>;
}

export const IssueDocumentRequestSchema = z.object({
  citizenId: z.string().uuid(),
  documentType: z.enum(DOCUMENT_TYPES),
  fields: z.record(z.unknown()),
});

export interface IssueDocumentResponse {
  document: DocumentRecord;
  version: DocumentVersion;
  /** true when this document type's requiresReview flag routed it into a review queue instead of issuing immediately. */
  routedToReview: boolean;
}

export const IssueDocumentResponseSchema = z.object({
  document: DocumentRecordSchema,
  version: DocumentVersionSchema,
  routedToReview: z.boolean(),
});

/** citizen-locker-api (Session 18): `POST /me/documents/:id/renew`. */
export interface RenewDocumentRequest {
  documentId: string;
}

export const RenewDocumentRequestSchema = z.object({
  documentId: z.string().uuid(),
});

export interface RenewDocumentResponse {
  /** The new draft renewal record, routed into the issuing agency's review queue. Agency approval is still required. */
  renewalRequestId: string;
  status: "draft";
  feeAmount: number | null;
  feeCurrency: CurrencyCode | null;
}

export const RenewDocumentResponseSchema = z.object({
  renewalRequestId: z.string().uuid(),
  status: z.literal("draft"),
  feeAmount: z.number().nonnegative().nullable(),
  feeCurrency: z.enum(CURRENCY_CODES).nullable(),
});
