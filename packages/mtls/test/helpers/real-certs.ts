import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test helper producing REAL X.509 certificates by invoking the actual
 * infra/scripts/generate-dev-certs.sh script against a throwaway temp
 * directory — not mocked/stubbed crypto. This is what "tests against real
 * certs" means for this package: every test using this helper is exercising
 * genuine openssl-issued certs and Node's real tls verification logic.
 */

const SCRIPT_PATH = join(__dirname, "..", "..", "..", "..", "infra", "scripts", "generate-dev-certs.sh");

export interface RealCertSet {
  dir: string;
  caPath: string;
  service: (name: string) => { certPath: string; keyPath: string };
  cleanup: () => void;
}

/** Generates a real dev CA plus real leaf certs for the given service names, in a fresh temp dir. */
export function generateRealCerts(serviceNames: string[]): RealCertSet {
  const dir = mkdtempSync(join(tmpdir(), "mtls-test-"));
  execFileSync("bash", [SCRIPT_PATH, dir, ...serviceNames], { stdio: "pipe" });

  return {
    dir,
    caPath: join(dir, "ca", "ca.crt"),
    service: (name: string) => ({
      certPath: join(dir, name, `${name}.crt`),
      keyPath: join(dir, name, `${name}.key`),
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Generates a real, but CA-foreign (self-signed, unrelated to the dev CA)
 * leaf certificate — used to test that a genuinely untrusted client is
 * rejected, as opposed to just "no client cert presented at all".
 */
export function generateForeignCert(dir: string, name: string): { certPath: string; keyPath: string } {
  const keyPath = join(dir, `${name}-foreign.key`);
  const certPath = join(dir, `${name}-foreign.crt`);

  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
  execFileSync("openssl", [
    "req",
    "-x509",
    "-new",
    "-key",
    keyPath,
    "-subj",
    `/C=XX/O=Untrusted Test Org/CN=${name}`,
    "-days",
    "1",
    "-out",
    certPath,
  ]);

  return { certPath, keyPath };
}

/** Generates a real, already-expired leaf cert signed by the given real CA — for expiry-rejection tests. */
export function generateExpiredCert(
  dir: string,
  name: string,
  ca: { caPath: string; caKeyPath: string },
): { certPath: string; keyPath: string } {
  const keyPath = join(dir, `${name}-expired.key`);
  const csrPath = join(dir, `${name}-expired.csr`);
  const certPath = join(dir, `${name}-expired.crt`);

  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
  execFileSync("openssl", [
    "req",
    "-new",
    "-key",
    keyPath,
    "-subj",
    `/C=LR/O=Liberia Document Locker (DEV ONLY)/CN=${name}`,
    "-out",
    csrPath,
  ]);

  // -not_before / -not_after in the past: a real expired cert, not a mocked one.
  execFileSync("openssl", [
    "x509",
    "-req",
    "-in",
    csrPath,
    "-CA",
    ca.caPath,
    "-CAkey",
    ca.caKeyPath,
    "-CAcreateserial",
    "-days",
    "-1",
    "-out",
    certPath,
  ]);

  return { certPath, keyPath };
}
