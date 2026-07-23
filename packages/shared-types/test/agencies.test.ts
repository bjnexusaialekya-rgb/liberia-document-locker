import { describe, expect, it } from "vitest";
import { AGENCY_REGISTRY, AgencySchema, isKnownAgencyCode } from "../src/agencies";
import { AGENCY_CODES } from "../src/enums";

describe("AGENCY_REGISTRY", () => {
  it("has exactly the 6 seeded agencies", () => {
    expect(Object.keys(AGENCY_REGISTRY).sort()).toEqual([...AGENCY_CODES].sort());
    expect(Object.keys(AGENCY_REGISTRY)).toHaveLength(6);
  });

  it("every entry produces a valid Agency once id/createdAt are supplied", () => {
    for (const code of AGENCY_CODES) {
      const candidate = {
        ...AGENCY_REGISTRY[code],
        id: "00000000-0000-0000-0000-000000000000",
        createdAt: new Date().toISOString(),
      };
      expect(() => AgencySchema.parse(candidate)).not.toThrow();
    }
  });

  it("isKnownAgencyCode correctly discriminates real vs. unknown codes", () => {
    expect(isKnownAgencyCode("LLA")).toBe(true);
    expect(isKnownAgencyCode("MOH")).toBe(false); // not yet onboarded, per blueprint
  });
});
