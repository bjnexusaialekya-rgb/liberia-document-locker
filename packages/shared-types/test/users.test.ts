import { describe, expect, it } from "vitest";
import { UserSchema, violatesSeparationOfDuties } from "../src/users";

describe("violatesSeparationOfDuties", () => {
  const agencyId = "11111111-1111-1111-1111-111111111111";
  const otherAgencyId = "99999999-9999-9999-9999-999999999999";

  it("blocks the same user holding ISSUER and APPROVER in the same agency", () => {
    const existing = [{ role: "ISSUER" as const, agencyId }];
    expect(violatesSeparationOfDuties(existing, { role: "APPROVER", agencyId })).toBe(true);
  });

  it("blocks the same user holding APPROVER and AUDITOR in the same agency", () => {
    const existing = [{ role: "APPROVER" as const, agencyId }];
    expect(violatesSeparationOfDuties(existing, { role: "AUDITOR", agencyId })).toBe(true);
  });

  it("allows the same conflict-set role granted twice (idempotent re-grant)", () => {
    const existing = [{ role: "ISSUER" as const, agencyId }];
    expect(violatesSeparationOfDuties(existing, { role: "ISSUER", agencyId })).toBe(false);
  });

  it("allows ISSUER in one agency and APPROVER in a different agency", () => {
    const existing = [{ role: "ISSUER" as const, agencyId }];
    expect(violatesSeparationOfDuties(existing, { role: "APPROVER", agencyId: otherAgencyId })).toBe(false);
  });

  it("does not restrict AGENCY_SUPERVISOR or PLATFORM_ADMIN (outside the conflict set)", () => {
    const existing = [{ role: "ISSUER" as const, agencyId }, { role: "APPROVER" as const, agencyId: otherAgencyId }];
    expect(violatesSeparationOfDuties(existing, { role: "AGENCY_SUPERVISOR", agencyId })).toBe(false);
  });
});

describe("UserSchema", () => {
  it("accepts a citizen with no agencyId", () => {
    const citizen = {
      id: "11111111-1111-1111-1111-111111111111",
      userType: "CITIZEN" as const,
      fullName: "Precious Kollie",
      nationalIdNumber: "NIN-0001",
      agencyId: null,
      phoneNumber: "+231770000000",
      email: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(() => UserSchema.parse(citizen)).not.toThrow();
  });

  it("rejects a non-Liberian phone number (wrong country code)", () => {
    const bad = {
      id: "11111111-1111-1111-1111-111111111111",
      userType: "CITIZEN" as const,
      fullName: "Precious Kollie",
      nationalIdNumber: "NIN-0001",
      agencyId: null,
      phoneNumber: "+14155550123", // US number — not valid on this platform
      email: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(() => UserSchema.parse(bad)).toThrow();
  });

  it("accepts a well-formed +231 Liberian mobile number", () => {
    const ok = {
      id: "11111111-1111-1111-1111-111111111111",
      userType: "CITIZEN" as const,
      fullName: "Precious Kollie",
      nationalIdNumber: "NIN-0001",
      agencyId: null,
      phoneNumber: "+231770000000",
      email: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(() => UserSchema.parse(ok)).not.toThrow();
  });

  it("rejects a malformed email", () => {
    const bad = {
      id: "11111111-1111-1111-1111-111111111111",
      userType: "PLATFORM_ADMIN" as const,
      fullName: "Admin",
      nationalIdNumber: null,
      agencyId: null,
      phoneNumber: null,
      email: "not-an-email",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(() => UserSchema.parse(bad)).toThrow();
  });
});
