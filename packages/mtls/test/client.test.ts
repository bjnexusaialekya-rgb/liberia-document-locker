import { describe, it, expect, afterAll } from "vitest";
import { buildMtlsAgent } from "../src/client";
import { CertFileNotFoundError } from "../src/errors";
import { generateRealCerts } from "./helpers/real-certs";

const certs = generateRealCerts(["document-issuance"]);
afterAll(() => certs.cleanup());

describe("buildMtlsAgent", () => {
  it("builds a real https.Agent carrying real client cert/key/CA material", () => {
    const svc = certs.service("document-issuance");
    const agent = buildMtlsAgent({ ...svc, caPath: certs.caPath });

    expect(agent.options.cert?.toString()).toContain("BEGIN CERTIFICATE");
    expect(agent.options.key?.toString()).toMatch(/BEGIN (EC )?PRIVATE KEY/);
    expect(agent.options.rejectUnauthorized).toBe(true);
  });

  it("throws CertFileNotFoundError when the client key file is missing", () => {
    const svc = certs.service("document-issuance");
    expect(() =>
      buildMtlsAgent({ certPath: svc.certPath, keyPath: "/nope.key", caPath: certs.caPath }),
    ).toThrow(CertFileNotFoundError);
  });
});
