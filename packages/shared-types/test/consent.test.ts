import { describe, expect, it } from "vitest";
import { canTransitionConsentState, ConsentGrantSchema } from "../src/consent";

describe("consent state machine", () => {
  it("allows pending_otp -> active", () => {
    expect(canTransitionConsentState("pending_otp", "active")).toBe(true);
  });

  it("allows pending_otp -> revoked (grant can be revoked before OTP confirmation)", () => {
    expect(canTransitionConsentState("pending_otp", "revoked")).toBe(true);
  });

  it("allows active -> expired and active -> revoked", () => {
    expect(canTransitionConsentState("active", "expired")).toBe(true);
    expect(canTransitionConsentState("active", "revoked")).toBe(true);
  });

  it("never allows leaving a terminal state", () => {
    expect(canTransitionConsentState("expired", "active")).toBe(false);
    expect(canTransitionConsentState("revoked", "active")).toBe(false);
    expect(canTransitionConsentState("expired", "revoked")).toBe(false);
  });

  it("never allows skipping straight from pending_otp to expired", () => {
    expect(canTransitionConsentState("pending_otp", "expired")).toBe(false);
  });
});

describe("ConsentGrantSchema", () => {
  const base = {
    id: "11111111-1111-1111-1111-111111111111",
    citizenId: "22222222-2222-2222-2222-222222222222",
    documentId: "33333333-3333-3333-3333-333333333333",
    granteeId: "44444444-4444-4444-4444-444444444444",
    purposeCode: "LOAN_APPLICATION",
    scopedFields: ["fullName", "nationalIdNumber"],
    state: "pending_otp" as const,
    otpConfirmedAt: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    revokedAt: null,
    createdAt: new Date().toISOString(),
  };

  it("accepts a well-formed pending grant", () => {
    expect(() => ConsentGrantSchema.parse(base)).not.toThrow();
  });

  it("rejects an empty scopedFields array (data minimization must name at least one field)", () => {
    expect(() => ConsentGrantSchema.parse({ ...base, scopedFields: [] })).toThrow();
  });

  it("rejects an unknown state value", () => {
    expect(() => ConsentGrantSchema.parse({ ...base, state: "approved" })).toThrow();
  });
});
