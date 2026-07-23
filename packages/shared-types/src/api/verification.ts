import { z } from "zod";
import { VERIFICATION_STATUSES, type VerificationStatus } from "../enums";

/**
 * verification-engine (Session 10, RFP #7): `POST /verify`.
 * A verification_token is only issued after consent-engine's OTP-gated grant —
 * this endpoint never accepts a raw document ID directly from an institution.
 * TTL: 15 minutes, reusable within that window (client-confirmed).
 */
export interface VerifyRequest {
  verificationToken: string;
}

export const VerifyRequestSchema = z.object({
  verificationToken: z.string().min(1),
});

/**
 * Data-minimized response — `minimalFields` contains only the fields the
 * underlying consent grant's `scopedFields` allowlist covers. Never the full
 * document, regardless of what the grant technically could expose.
 */
export interface VerifyResponse {
  status: VerificationStatus;
  minimalFields: Record<string, unknown> | null; // null when status === "not_verified"
  checkedAt: string; // ISO 8601
}

export const VerifyResponseSchema = z.object({
  status: z.enum(VERIFICATION_STATUSES),
  minimalFields: z.record(z.unknown()).nullable(),
  checkedAt: z.string().datetime(),
});

/**
 * offline-verifier (Session 12, RFP #1 + offline half of #8): the daily
 * compressed Revocation/Seizure List a field-officer device ingests alongside
 * cached public keys. Generated directly from `documents.is_physical_asset_held`
 * — this is the wire shape of that export, not a separately maintained dataset.
 */
export interface RevocationSeizureListEntry {
  documentId: string;
  reason: "seized" | "suspended" | "revoked";
  effectiveAt: string; // ISO 8601
}

export const RevocationSeizureListEntrySchema = z.object({
  documentId: z.string().uuid(),
  reason: z.enum(["seized", "suspended", "revoked"]),
  effectiveAt: z.string().datetime(),
});

export interface RevocationSeizureListResponse {
  generatedAt: string; // ISO 8601
  entries: RevocationSeizureListEntry[];
}

export const RevocationSeizureListResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  entries: z.array(RevocationSeizureListEntrySchema),
});
