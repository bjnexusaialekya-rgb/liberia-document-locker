import { readFileSync } from "node:fs";
import type { SecureContextOptions } from "node:tls";
import { createSecureContext } from "node:tls";
import type { MtlsCertPaths } from "./types";
import { CertFileNotFoundError } from "./errors";

/** Reads a single PEM file, translating a missing-file error into a typed one. */
function readPemFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (cause) {
    throw new CertFileNotFoundError(path, cause);
  }
}

/**
 * TLS server options for mutual TLS: this service's own cert/key as the
 * server credential, plus the shared CA as the trust anchor for verifying
 * callers.
 *
 * `requestCert: true` so the server asks every connecting client for a
 * certificate. `rejectUnauthorized: false` **at the TLS layer** — this is
 * deliberate, not a relaxed security posture: Node still populates
 * `socket.authorized` / `socket.authorizationError` correctly either way,
 * but with `rejectUnauthorized: true` an untrusted or missing client cert
 * gets the raw TCP connection reset before any application code runs,
 * which means callers only ever see a connection-reset error with no
 * actionable detail, and `requireMtls`'s typed 401/403 JSON responses (and
 * its `onRejected` audit-log hook) never get a chance to run.
 *
 * The actual trust decision is NOT skipped — it moves one layer up, into
 * `requireMtls` (via `requirePeerIdentity`), which reads `socket.authorized`
 * and rejects unauthorized callers itself. **This means `requireMtls` is
 * mandatory on every route mounted on a server built from these options —
 * `rejectUnauthorized: false` here relies on it being applied; there is no
 * enforcement left at the transport layer.** This tradeoff is what makes
 * "tested against real certs, with a real HTTP-level rejection response" the
 * behavior instead of "tested against a raw socket disconnect".
 *
 * Pass the result straight to `https.createServer(options, app)`.
 */
export function buildTlsServerOptions(paths: MtlsCertPaths): {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
  requestCert: true;
  rejectUnauthorized: false;
} {
  return {
    cert: readPemFile(paths.certPath),
    key: readPemFile(paths.keyPath),
    ca: readPemFile(paths.caPath),
    requestCert: true,
    rejectUnauthorized: false,
  };
}

/**
 * Builds a `tls.SecureContext` from the same three files — used by
 * cert-watcher to hot-swap a running server's credentials via
 * `server.setSecureContext()` after rotation, without restarting the process.
 */
export function buildSecureContext(paths: MtlsCertPaths): ReturnType<typeof createSecureContext> {
  const options: SecureContextOptions = {
    cert: readPemFile(paths.certPath),
    key: readPemFile(paths.keyPath),
    ca: readPemFile(paths.caPath),
  };
  return createSecureContext(options);
}
