import { z } from "zod";
import { AGENCY_CODES, type AgencyCode } from "./enums";

/** A single government agency / issuing authority. Mirrors the `agencies` table (migration 002). */
export interface Agency {
  id: string; // UUID
  code: AgencyCode;
  name: string;
  fullName: string;
  createdAt: string; // ISO 8601
}

export const AgencySchema = z.object({
  id: z.string().uuid(),
  code: z.enum(AGENCY_CODES),
  name: z.string().min(1),
  fullName: z.string().min(1),
  createdAt: z.string().datetime(),
});

/**
 * Static reference data for the 6 seeded agencies. Not a substitute for the DB row
 * (no `id`/`createdAt` — those are assigned at seed time) — this is the fixed,
 * source-of-truth naming every service can import without a DB round trip,
 * e.g. for UI labels, README generation, or seed-data verification in tests.
 *
 * NIR is retained here as the placeholder FK target for BIRTH_CERT, HEALTH_RECORD,
 * and EDUCATION_RECORD until Ministry of Health / Ministry of Education are onboarded
 * as real agency rows (see master blueprint, 2026-07-19 verification note).
 */
export const AGENCY_REGISTRY: Record<AgencyCode, Omit<Agency, "id" | "createdAt">> = {
  NIR: {
    code: "NIR",
    name: "NIR",
    fullName: "National Identification Registry",
  },
  MOT: {
    code: "MOT",
    name: "MOT",
    fullName: "Ministry of Transport",
  },
  LNP: {
    code: "LNP",
    name: "LNP",
    fullName: "Liberia National Police",
  },
  LBR: {
    code: "LBR",
    name: "LBR",
    fullName: "Liberia Business Registry",
  },
  LRA: {
    code: "LRA",
    name: "LRA",
    fullName: "Liberia Revenue Authority",
  },
  LLA: {
    code: "LLA",
    name: "LLA",
    fullName: "Liberia Land Authority",
  },
};

export function isKnownAgencyCode(value: string): value is AgencyCode {
  return (AGENCY_CODES as readonly string[]).includes(value);
}
