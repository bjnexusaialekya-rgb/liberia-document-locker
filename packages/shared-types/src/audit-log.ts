import { z } from "zod";
import { USER_TYPES, type UserType } from "./enums";

/**
 * Event-type taxonomy for the hash-chained append-only `audit-log` service
 * (RFP #10, Phase 0 — every other service writes to this from day one).
 * Not exhaustive of every possible future event, but every event type currently
 * named across the blueprint's 14 services is represented so packages/audit-log
 * (Session 5) and every service after it share one enum instead of each
 * inventing string literals independently.
 */
export const AUDIT_EVENT_TYPES = [
  // documents / document-issuance
  "document.issued",
  "document.amended",
  "document.suspended",
  "document.revoked",
  "document.archived",
  "document.renewal_requested",
  // consent-engine
  "consent.grant_requested",
  "consent.grant_otp_confirmed",
  "consent.grant_revoked",
  "consent.grant_expired",
  // verification-engine / qr-verification / offline-verifier
  "verification.token_issued",
  "verification.checked",
  "verification.offline_token_issued",
  "verification.offline_token_revoked",
  // payment-engine
  "payment.initiated",
  "payment.completed",
  "payment.failed",
  "payment.reconciled",
  "payment.refunded",
  // auth
  "auth.login_succeeded",
  "auth.login_failed",
  "auth.otp_issued",
  "auth.offline_token_issued",
  // admin-api / packages/kms
  "kms.key_rotated",
  "kms.key_destroyed_erasure_request",
  "admin.break_glass_override",
  // reporting-engine
  "anomaly.staff_account_suspended",
  "anomaly.staff_account_reinstated",
  "anomaly.threshold_adjusted",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/**
 * A single hash-chained audit-log entry. `prevHash`/`hash` form the chain;
 * `signature` is the sender's signature over the entry (Phase 0: every
 * inter-service message is signed by the sender before being written here).
 * `GET /audit/verify-chain` (Phase 0 test gate) walks entries in order and
 * confirms hash(entry_n) using prevHash(entry_n) === hash(entry_{n-1}).
 */
export interface AuditLogEvent {
  id: string; // UUID
  eventType: AuditEventType;
  actorId: string; // UUID of the user or service principal that triggered this
  actorType: UserType | "SERVICE";
  agencyId: string | null; // UUID — null for platform-level events with no single agency scope
  resourceType: string; // e.g. "document", "consent_grant", "payment"
  resourceId: string; // UUID of the affected resource
  /** Free-form structured detail specific to the event type. Never raw PII — see packages/kms crypto-shredding note. */
  metadata: Record<string, unknown>;
  payloadHash: string; // sha256 hex of the canonicalized event payload
  prevHash: string | null; // null only for the very first entry in the chain
  hash: string; // sha256 hex of (prevHash + payloadHash), the chain link itself
  signature: string; // sender's signature over `hash`, verified via packages/mtls cert
  createdAt: string; // ISO 8601
}

export const AuditLogEventSchema = z.object({
  id: z.string().uuid(),
  eventType: z.enum(AUDIT_EVENT_TYPES),
  actorId: z.string().uuid(),
  actorType: z.union([z.enum(USER_TYPES), z.literal("SERVICE")]),
  agencyId: z.string().uuid().nullable(),
  resourceType: z.string().min(1),
  resourceId: z.string().uuid(),
  metadata: z.record(z.unknown()),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/i, "expected sha256 hex digest"),
  prevHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .nullable(),
  hash: z.string().regex(/^[a-f0-9]{64}$/i, "expected sha256 hex digest"),
  signature: z.string().min(1),
  createdAt: z.string().datetime(),
});

/** Request shape for the shared audit-log write endpoint every service calls. */
export interface AuditLogWriteRequest {
  eventType: AuditEventType;
  actorId: string;
  actorType: UserType | "SERVICE";
  agencyId: string | null;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  signature: string;
}

export const AuditLogWriteRequestSchema = z.object({
  eventType: z.enum(AUDIT_EVENT_TYPES),
  actorId: z.string().uuid(),
  actorType: z.union([z.enum(USER_TYPES), z.literal("SERVICE")]),
  agencyId: z.string().uuid().nullable(),
  resourceType: z.string().min(1),
  resourceId: z.string().uuid(),
  metadata: z.record(z.unknown()),
  signature: z.string().min(1),
});
