import { describe, expect, it } from "vitest";
import {
  DOCUMENT_TYPE_REGISTRY,
  DocumentTypeDefinitionSchema,
  getPlaceholderAgencyDocumentTypes,
  isPhase1DocumentType,
  isRenewable,
} from "../src/document-types";
import { DOCUMENT_TYPES, PHASE_1_DOCUMENT_TYPES } from "../src/enums";

describe("DOCUMENT_TYPE_REGISTRY", () => {
  it("has exactly 10 entries, one per DocumentType", () => {
    expect(Object.keys(DOCUMENT_TYPE_REGISTRY)).toHaveLength(10);
    for (const t of DOCUMENT_TYPES) {
      expect(DOCUMENT_TYPE_REGISTRY[t]).toBeDefined();
      expect(DOCUMENT_TYPE_REGISTRY[t].type).toBe(t);
    }
  });

  it("every entry validates against DocumentTypeDefinitionSchema", () => {
    for (const t of DOCUMENT_TYPES) {
      expect(() => DocumentTypeDefinitionSchema.parse(DOCUMENT_TYPE_REGISTRY[t])).not.toThrow();
    }
  });

  it("has exactly the 6 locked Phase 1 types, matching PHASE_1_DOCUMENT_TYPES", () => {
    const phase1InRegistry = DOCUMENT_TYPES.filter((t) => DOCUMENT_TYPE_REGISTRY[t].isPhase1);
    expect(phase1InRegistry.sort()).toEqual([...PHASE_1_DOCUMENT_TYPES].sort());
    expect(phase1InRegistry).toHaveLength(6);
  });

  it("locks Land Title to LLA, not LRA (2026-07-19 correction)", () => {
    expect(DOCUMENT_TYPE_REGISTRY.LAND_TITLE.issuingAgency).toBe("LLA");
    expect(DOCUMENT_TYPE_REGISTRY.LAND_TITLE.isPhase1).toBe(false);
  });

  it("locks Tax Certificate to LRA as the Phase 1 slot (chosen over Land Title)", () => {
    expect(DOCUMENT_TYPE_REGISTRY.TAX_CERTIFICATE.issuingAgency).toBe("LRA");
    expect(DOCUMENT_TYPE_REGISTRY.TAX_CERTIFICATE.isPhase1).toBe(true);
  });

  it("requires_review matches the blueprint's risk-tiered workflow (RFP #3)", () => {
    const requiresReviewTrue = ["NATIONAL_ID", "DRIVERS_LICENSE", "VEHICLE_REGISTRATION", "LAND_TITLE"];
    const requiresReviewFalse = ["TRAFFIC_TICKET", "BUSINESS_LICENSE", "TAX_CERTIFICATE"];
    for (const t of requiresReviewTrue) {
      expect(DOCUMENT_TYPE_REGISTRY[t as keyof typeof DOCUMENT_TYPE_REGISTRY].requiresReview).toBe(true);
    }
    for (const t of requiresReviewFalse) {
      expect(DOCUMENT_TYPE_REGISTRY[t as keyof typeof DOCUMENT_TYPE_REGISTRY].requiresReview).toBe(false);
    }
  });

  it("Driver's License uses ISO 18013-5 mDoc; every other type uses W3C VC", () => {
    expect(DOCUMENT_TYPE_REGISTRY.DRIVERS_LICENSE.credentialFormat).toBe("ISO_18013_5_MDOC");
    for (const t of DOCUMENT_TYPES) {
      if (t === "DRIVERS_LICENSE") continue;
      expect(DOCUMENT_TYPE_REGISTRY[t].credentialFormat).toBe("W3C_VC");
    }
  });

  it("tracksPhysicalAssetCustody is true only for Driver's License and Vehicle Registration", () => {
    const expected = new Set(["DRIVERS_LICENSE", "VEHICLE_REGISTRATION"]);
    for (const t of DOCUMENT_TYPES) {
      expect(DOCUMENT_TYPE_REGISTRY[t].tracksPhysicalAssetCustody).toBe(expected.has(t));
    }
  });

  it("flags exactly BIRTH_CERT, HEALTH_RECORD, EDUCATION_RECORD as placeholder-agency (stubbed against NIR)", () => {
    expect(getPlaceholderAgencyDocumentTypes().sort()).toEqual(
      ["BIRTH_CERT", "HEALTH_RECORD", "EDUCATION_RECORD"].sort(),
    );
    for (const t of getPlaceholderAgencyDocumentTypes()) {
      expect(DOCUMENT_TYPE_REGISTRY[t].issuingAgency).toBe("NIR");
    }
  });

  it("isRenewable matches renewal-eligible types from citizen-locker-api (RFP #2)", () => {
    const renewable = ["NATIONAL_ID", "DRIVERS_LICENSE", "VEHICLE_REGISTRATION", "BUSINESS_LICENSE", "TAX_CERTIFICATE"];
    const notRenewable = ["TRAFFIC_TICKET", "LAND_TITLE", "BIRTH_CERT", "HEALTH_RECORD", "EDUCATION_RECORD"];
    for (const t of renewable) expect(isRenewable(t as keyof typeof DOCUMENT_TYPE_REGISTRY)).toBe(true);
    for (const t of notRenewable) expect(isRenewable(t as keyof typeof DOCUMENT_TYPE_REGISTRY)).toBe(false);
  });

  it("isPhase1DocumentType agrees with the registry's isPhase1 flag for all 10 types", () => {
    for (const t of DOCUMENT_TYPES) {
      expect(isPhase1DocumentType(t)).toBe(DOCUMENT_TYPE_REGISTRY[t].isPhase1);
    }
  });
});
