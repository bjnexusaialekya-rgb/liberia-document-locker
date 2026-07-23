/**
 * Shared type surface for packages/mtls.
 */

/** Identity of the calling service, derived from its validated client certificate. */
export interface PeerIdentity {
  /** Common Name on the peer's leaf certificate — the service name (e.g. "document-issuance"). */
  readonly serviceName: string;
  /** DNS names from the certificate's Subject Alternative Name extension, CN included if also a DNS SAN. */
  readonly sanDnsNames: readonly string[];
  /** Certificate fingerprint (SHA-256, hex), useful for audit-log correlation. */
  readonly fingerprint256: string;
  /** Certificate's notAfter, as an ISO-8601 string, for logging/alerting on upcoming expiry. */
  readonly validTo: string;
}

/** File paths for a single service's mTLS material. */
export interface MtlsCertPaths {
  /** Path to this service's own certificate (used as the server cert, and as the client cert on outbound calls). */
  readonly certPath: string;
  /** Path to this service's own private key. */
  readonly keyPath: string;
  /** Path to the CA certificate used to validate peers. */
  readonly caPath: string;
}

/** Configuration shared by the server-options builder, the middleware, and the outbound client helper. */
export interface MtlsConfig extends MtlsCertPaths {
  /**
   * Service names allowed to call in. If omitted or empty, any peer presenting
   * a certificate signed by the trusted CA is accepted (CA trust only, no
   * per-caller allowlist) — set this whenever an endpoint should only be
   * reachable by specific callers.
   */
  readonly allowedServiceNames?: readonly string[];
}
