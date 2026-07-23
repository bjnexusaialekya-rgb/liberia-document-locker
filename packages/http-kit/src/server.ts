import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { toApiError } from "./errors.js";
import type { HttpLogHooks } from "./logging.js";

/**
 * NOTE: shared-types (`@liberia-locker/shared-types`) defines `ApiErrorShape`
 * but has no corresponding success envelope — only `ApiErrorShape`,
 * `PaginatedResponse`, and pagination params. This envelope is http-kit's
 * own convention, kept symmetric with ApiErrorShape's `requestId` field so
 * every response (success or error) carries a correlatable request id.
 * If shared-types adds an official success envelope later, switch this to
 * import from there instead.
 */
export interface ApiSuccessEnvelope<T> {
  data: T;
  requestId: string;
  timestamp: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * Assigns a request id (reusing an inbound `x-request-id` from a calling
 * service, or minting a new one at the edge) and echoes it back on the
 * response. Every downstream module in this package (validation errors,
 * idempotency errors, logging hooks) keys off `req.requestId`.
 */
export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header("x-request-id");
    const id = incoming && incoming.length > 0 ? incoming : randomUUID();
    req.requestId = id;
    res.setHeader("x-request-id", id);
    next();
  };
}

/** Wraps `data` in the standard success envelope and sends it with the given status (default 200). */
export function sendSuccess<T>(req: Request, res: Response, data: T, status = 200): void {
  const envelope: ApiSuccessEnvelope<T> = {
    data,
    requestId: req.requestId ?? "unknown",
    timestamp: new Date().toISOString(),
  };
  res.status(status).json(envelope);
}

/**
 * Central error-handling middleware. Mount this LAST, after all routes.
 * Converts any thrown value (ApiError or otherwise) into the standard
 * error shape, logs it via hooks, and never leaks internals for
 * unexpected (non-ApiError) errors — only the generic INTERNAL_ERROR
 * message reaches the client, full detail goes to the log hook only.
 */
export function errorHandler(hooks?: HttpLogHooks): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const apiError = toApiError(err);
    const id = req.requestId ?? "unknown";

    hooks?.onError?.({
      requestId: id,
      code: apiError.code,
      message: apiError.message,
      status: apiError.status,
      cause: apiError.cause,
    });

    res.status(apiError.status).json(apiError.toJSON(id));
  };
}

/**
 * Wraps an async route handler so rejected promises are forwarded to
 * `next()` instead of crashing the process — Express 4 does not do this
 * automatically. Every route in every service should be wrapped in this.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/**
 * Request/response logging middleware, wired to the same HttpLogHooks
 * used elsewhere in this package so a service gets one consistent log
 * stream shape across inbound requests, outbound client calls, and
 * idempotency/retry events.
 */
export function requestLogging(hooks: HttpLogHooks): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    const id = req.requestId ?? "unknown";
    hooks.onRequestStart?.({ method: req.method, path: req.path, requestId: id });
    res.on("finish", () => {
      hooks.onRequestEnd?.({
        method: req.method,
        path: req.path,
        requestId: id,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  };
}
