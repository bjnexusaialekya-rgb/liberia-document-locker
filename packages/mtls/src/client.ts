import { readFileSync } from "node:fs";
import { Agent } from "node:https";
import type { MtlsCertPaths } from "./types";
import { CertFileNotFoundError } from "./errors";

function readPemFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (cause) {
    throw new CertFileNotFoundError(path, cause);
  }
}

/**
 * Builds an `https.Agent` presenting this service's own cert/key as the
 * client credential, and trusting the shared CA for the far end's server
 * cert — the outbound half of mutual TLS. Every service-to-service HTTP
 * call in this platform should go through an agent built by this function
 * (or through http-kit's client, once that package exists and wraps this).
 *
 * `rejectUnauthorized: true` — an outbound call must reject a callee whose
 * server certificate isn't signed by the shared dev/production CA, the
 * same as the inbound side enforces via {@link buildTlsServerOptions}.
 */
export function buildMtlsAgent(paths: MtlsCertPaths): Agent {
  return new Agent({
    cert: readPemFile(paths.certPath),
    key: readPemFile(paths.keyPath),
    ca: readPemFile(paths.caPath),
    rejectUnauthorized: true,
  });
}
