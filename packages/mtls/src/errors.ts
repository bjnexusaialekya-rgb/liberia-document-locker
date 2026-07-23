/**
 * Typed error hierarchy for packages/mtls.
 *
 * Distinct classes rather than string-matching, so callers (and http-kit's
 * error-shape middleware, once that package exists) can tell "no cert
 * presented at all" apart from "cert presented but not CA-trusted" apart
 * from "CA-trusted but not on this endpoint's allowlist" — these map to
 * different remediation steps and different audit-log severities.
 */

export class MtlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** One or more required cert/key/CA files were missing on disk at startup. */
export class CertFileNotFoundError extends MtlsError {
  constructor(public readonly path: string, cause?: unknown) {
    super(`mTLS material not found at "${path}"${cause ? `: ${String(cause)}` : ""}`);
  }
}

/**
 * The TLS handshake completed but the peer did not present a client
 * certificate at all. Distinct from PeerCertUntrustedError: this is a
 * misconfigured or non-mTLS caller, not a rejected/forged certificate.
 */
export class PeerCertMissingError extends MtlsError {
  constructor() {
    super("No client certificate was presented on this connection.");
  }
}

/**
 * A client certificate was presented but Node's TLS layer did not consider
 * it authorized (not signed by the configured CA, expired, or otherwise
 * invalid). Carries the underlying reason string from the TLS socket.
 */
export class PeerCertUntrustedError extends MtlsError {
  constructor(public readonly reason: string) {
    super(`Client certificate is not trusted: ${reason}`);
  }
}

/**
 * The peer's certificate was CA-trusted and successfully identified, but its
 * service name is not on the calling endpoint's allowlist. This is an
 * authorization failure, not an authentication failure — log and alert on
 * this distinctly, since it can indicate a compromised or misconfigured
 * service attempting to reach an endpoint it has no business calling.
 */
export class PeerNotAuthorizedError extends MtlsError {
  constructor(
    public readonly serviceName: string,
    public readonly allowedServiceNames: readonly string[],
  ) {
    super(
      `Service "${serviceName}" is not authorized for this endpoint ` +
        `(allowed: ${allowedServiceNames.join(", ") || "<none configured>"}).`,
    );
  }
}

/** Hot-reloading a rotated cert/key pair into a running server or agent failed. */
export class CertRotationError extends MtlsError {
  constructor(public readonly path: string, cause: unknown) {
    super(`Failed to reload rotated cert material from "${path}": ${String(cause)}`);
  }
}
