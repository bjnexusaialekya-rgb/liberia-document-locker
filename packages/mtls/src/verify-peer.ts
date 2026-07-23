import type { TLSSocket } from "node:tls";
import type { PeerIdentity } from "./types";
import { PeerCertMissingError, PeerCertUntrustedError, PeerNotAuthorizedError } from "./errors";

/**
 * Extracts a {@link PeerIdentity} from an already-authorized mTLS socket.
 *
 * Must only be called after confirming `socket.authorized === true` —
 * this function does not itself check trust, it reads the identity out of
 * a certificate the TLS layer has already validated against the CA. Use
 * {@link requirePeerIdentity} if you want the trust check and extraction
 * done together.
 */
export function extractPeerIdentity(socket: TLSSocket): PeerIdentity {
  const cert = socket.getPeerCertificate(false);

  if (!cert || Object.keys(cert).length === 0) {
    throw new PeerCertMissingError();
  }

  const cn = cert.subject?.CN;
  const serviceName = Array.isArray(cn) ? cn[0] : cn;
  if (!serviceName) {
    throw new PeerCertUntrustedError("certificate has no Common Name (CN) to identify the caller");
  }

  const sanDnsNames = parseSanDnsNames(cert.subjectaltname);

  return {
    serviceName,
    sanDnsNames,
    fingerprint256: cert.fingerprint256,
    validTo: new Date(cert.valid_to).toISOString(),
  };
}

/**
 * The single entry point most callers should use: confirms the TLS layer
 * authorized the peer, then extracts and returns its identity. Throws a
 * specific typed error for "no cert presented" vs. "cert presented but not
 * trusted" so callers can log/alert on them differently.
 */
export function requirePeerIdentity(socket: TLSSocket): PeerIdentity {
  if (!socket.authorized) {
    // A cert may still have been presented even though it wasn't authorized
    // (e.g. self-signed, expired, wrong CA) — surface which case this is.
    const presentedCert = socket.getPeerCertificate(false);
    if (!presentedCert || Object.keys(presentedCert).length === 0) {
      throw new PeerCertMissingError();
    }
    throw new PeerCertUntrustedError(socket.authorizationError?.toString() ?? "unknown reason");
  }

  return extractPeerIdentity(socket);
}

/**
 * Enforces a per-endpoint allowlist on top of an already-authenticated
 * identity. Call this after {@link requirePeerIdentity} when an endpoint
 * should only be reachable by specific named services, not just any
 * CA-trusted caller.
 */
export function assertPeerAuthorized(
  identity: PeerIdentity,
  allowedServiceNames: readonly string[] | undefined,
): void {
  if (!allowedServiceNames || allowedServiceNames.length === 0) {
    return;
  }
  if (!allowedServiceNames.includes(identity.serviceName)) {
    throw new PeerNotAuthorizedError(identity.serviceName, allowedServiceNames);
  }
}

function parseSanDnsNames(subjectaltname: string | undefined): string[] {
  if (!subjectaltname) return [];
  // Node formats this as e.g. "DNS:auth, DNS:localhost, DNS:auth.internal"
  return subjectaltname
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice("DNS:".length));
}
