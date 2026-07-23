import { z } from "zod";
import { CONSENT_STATES, type ConsentState } from "./enums";

/**
 * Mirrors `consent_grants` (RFP #6 / consent-engine, Session 9).
 * State machine: pending_otp -> active -> (expired | revoked).
 * OTP confirmation is required for EVERY document type — no instant grants,
 * no tiering by sensitivity (client-confirmed, max-friction-by-design).
 */
export interface ConsentGrant {
  id: string; // UUID
  citizenId: string; // UUID
  documentId: string; // UUID
  granteeId: string; // UUID — the institution/user being granted access
  purposeCode: string; // e.g. "LOAN_APPLICATION", "EMPLOYMENT_VERIFICATION"
  scopedFields: string[]; // data-minimized field allowlist, never "all fields" implicitly
  state: ConsentState;
  otpConfirmedAt: string | null; // ISO 8601 — null while state === "pending_otp"
  expiresAt: string; // ISO 8601
  revokedAt: string | null; // ISO 8601 — set only when state === "revoked"
  createdAt: string; // ISO 8601
}

export const ConsentGrantSchema = z.object({
  id: z.string().uuid(),
  citizenId: z.string().uuid(),
  documentId: z.string().uuid(),
  granteeId: z.string().uuid(),
  purposeCode: z.string().min(1),
  scopedFields: z.array(z.string().min(1)).min(1),
  state: z.enum(CONSENT_STATES),
  otpConfirmedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

/** Legal transitions for the consent state machine. Revocation is reachable from any live state. */
export const CONSENT_STATE_TRANSITIONS: Record<ConsentState, readonly ConsentState[]> = {
  pending_otp: ["active", "revoked"],
  active: ["expired", "revoked"],
  expired: [],
  revoked: [],
};

export function canTransitionConsentState(from: ConsentState, to: ConsentState): boolean {
  return CONSENT_STATE_TRANSITIONS[from].includes(to);
}
