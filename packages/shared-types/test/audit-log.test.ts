import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_TYPES, AuditLogEventSchema, AuditLogWriteRequestSchema } from "../src/audit-log";

const validHash = "a".repeat(64);

describe("AuditLogEventSchema", () => {
  const base = {
    id: "11111111-1111-1111-1111-111111111111",
    eventType: "document.issued" as const,
    actorId: "22222222-2222-2222-2222-222222222222",
    actorType: "AGENCY_STAFF" as const,
    agencyId: "33333333-3333-3333-3333-333333333333",
    resourceType: "document",
    resourceId: "44444444-4444-4444-4444-444444444444",
    metadata: { documentType: "NATIONAL_ID" },
    payloadHash: validHash,
    prevHash: null,
    hash: validHash,
    signature: "base64signaturehere",
    createdAt: new Date().toISOString(),
  };

  it("accepts a well-formed first-in-chain event (prevHash null)", () => {
    expect(() => AuditLogEventSchema.parse(base)).not.toThrow();
  });

  it("accepts SERVICE as an actorType for service-to-service events", () => {
    expect(() => AuditLogEventSchema.parse({ ...base, actorType: "SERVICE" })).not.toThrow();
  });

  it("rejects a malformed hash (must be 64-char hex)", () => {
    expect(() => AuditLogEventSchema.parse({ ...base, hash: "not-a-hash" })).toThrow();
  });

  it("rejects an eventType outside the shared taxonomy", () => {
    expect(() => AuditLogEventSchema.parse({ ...base, eventType: "document.deleted" })).toThrow();
  });

  it("every AUDIT_EVENT_TYPES entry is unique", () => {
    expect(new Set(AUDIT_EVENT_TYPES).size).toBe(AUDIT_EVENT_TYPES.length);
  });
});

describe("AuditLogWriteRequestSchema", () => {
  it("accepts a valid write request with agencyId null (platform-level event)", () => {
    const req = {
      eventType: "kms.key_rotated" as const,
      actorId: "11111111-1111-1111-1111-111111111111",
      actorType: "PLATFORM_ADMIN" as const,
      agencyId: null,
      resourceType: "kms_key",
      resourceId: "22222222-2222-2222-2222-222222222222",
      metadata: {},
      signature: "sig",
    };
    expect(() => AuditLogWriteRequestSchema.parse(req)).not.toThrow();
  });
});
