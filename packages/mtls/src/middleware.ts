import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { TLSSocket } from "node:tls";
import type { PeerIdentity } from "./types";
import { requirePeerIdentity, assertPeerAuthorized } from "./verify-peer";
import { MtlsError } from "./errors";

/** Augments Express's Request with the caller's validated mTLS identity. */
declare module "express" {
  interface Request {
    mtls?: PeerIdentity;
  }
}

export interface RequireMtlsOptions {
  /**
   * Service names allowed to call this endpoint. Omit to accept any peer
   * whose certificate is signed by the trusted CA (see MtlsConfig for the
   * same tradeoff at the config level).
   */
  allowedServiceNames?: readonly string[];
  /**
   * Called with the typed MtlsError when validation fails, before the
   * default 401/403 response is sent — use this to write to audit-log.
   * Does not suppress the default response; it runs in addition to it.
   */
  onRejected?: (error: MtlsError, req: Request) => void;
}

/**
 * Express middleware enforcing mutual TLS on the current request.
 *
 * Assumes the underlying HTTPS server was created with
 * {@link buildTlsServerOptions} (`requestCert: true, rejectUnauthorized: true`) —
 * this middleware trusts the TLS layer's `socket.authorized` flag rather than
 * re-validating the certificate chain itself. Node has already done the
 * cryptographic verification by the time a request reaches Express; this
 * middleware's job is identity extraction and the per-endpoint allowlist.
 *
 * On success, sets `req.mtls` to the caller's {@link PeerIdentity} and calls
 * `next()`. On failure, responds directly (401 for "no/untrusted cert", 403
 * for "trusted but not on this endpoint's allowlist") and does not call
 * `next()`.
 */
export function requireMtls(options: RequireMtlsOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const socket = req.socket as TLSSocket;

    try {
      const identity = requirePeerIdentity(socket);
      assertPeerAuthorized(identity, options.allowedServiceNames);
      req.mtls = identity;
      next();
    } catch (error) {
      if (!(error instanceof MtlsError)) {
        throw error;
      }

      options.onRejected?.(error, req);

      const status = error.name === "PeerNotAuthorizedError" ? 403 : 401;
      res.status(status).json({
        error: {
          code: error.name,
          message: error.message,
        },
      });
    }
  };
}
