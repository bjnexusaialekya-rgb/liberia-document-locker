import { describe, it, expect, afterAll } from "vitest";
import { buildTlsServerOptions, buildSecureContext } from "../src/server-options";
import { CertFileNotFoundError } from "../src/errors";
import { generateRealCerts } from "./helpers/real-certs";

const certs = generateRealCerts(["auth"]);
afterAll(() => certs.cleanup());

describe("buildTlsServerOptions", () => {
  it("loads real PEM material and sets mandatory mTLS flags", () => {
    const svc = certs.service("auth");
    const options = buildTlsServerOptions({ ...svc, caPath: certs.caPath });

    expect(options.cert.toString()).toContain("BEGIN CERTIFICATE");
    expect(options.key.toString()).toMatch(/BEGIN (EC )?PRIVATE KEY/);
    expect(options.ca.toString()).toContain("BEGIN CERTIFICATE");
    expect(options.requestCert).toBe(true);
    // Deliberately false at the TLS layer — see server-options.ts for why;
    // requireMtls is what actually enforces the trust decision.
    expect(options.rejectUnauthorized).toBe(false);
  });

  it("throws CertFileNotFoundError for a missing cert path", () => {
    expect(() =>
      buildTlsServerOptions({
        certPath: "/nonexistent/does-not-exist.crt",
        keyPath: certs.service("auth").keyPath,
        caPath: certs.caPath,
      }),
    ).toThrow(CertFileNotFoundError);
  });
});

describe("buildSecureContext", () => {
  it("builds a usable tls.SecureContext from real cert material", () => {
    const svc = certs.service("auth");
    const context = buildSecureContext({ ...svc, caPath: certs.caPath });
    expect(context.context).toBeDefined();
  });
});
