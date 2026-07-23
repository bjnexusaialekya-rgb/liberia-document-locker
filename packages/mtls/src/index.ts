/**
 * @liberia-locker/mtls
 *
 * Foundation package (Phase 0, Session 3). Mutual TLS between all internal
 * services: server-side options for terminating mTLS, an Express middleware
 * for enforcing it per-request and extracting caller identity, an outbound
 * client agent for the calling side, and hot-reload support for certificate
 * rotation. See README.md for setup (including the dev-CA generation script)
 * and the production-gap note.
 */

export type { PeerIdentity, MtlsCertPaths, MtlsConfig } from "./types";

export {
  MtlsError,
  CertFileNotFoundError,
  PeerCertMissingError,
  PeerCertUntrustedError,
  PeerNotAuthorizedError,
  CertRotationError,
} from "./errors";

export { buildTlsServerOptions, buildSecureContext } from "./server-options";

export { extractPeerIdentity, requirePeerIdentity, assertPeerAuthorized } from "./verify-peer";

export { requireMtls } from "./middleware";
export type { RequireMtlsOptions } from "./middleware";

export { watchCertsForRotation } from "./cert-watcher";
export type { CertWatcherOptions } from "./cert-watcher";

export { buildMtlsAgent } from "./client";
