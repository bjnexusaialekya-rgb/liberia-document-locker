import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKeySchema } from "@liberia-locker/shared-types";
import { ApiError } from "./errors.js";
import type { HttpLogHooks } from "./logging.js";

/**
 * Idempotency-key handling — flagged in the Session 4 prompt as needed
 * later for payment-engine (IIPS's documented reliability history means a
 * missed/duplicated payment-confirmation call must not double-credit).
 * This module implements the general middleware; payment-engine wires it
 * with its own store and TTL when that session is built.
 */

export type IdempotencyRecordStatus = "in-flight" | "completed";

export interface IdempotencyRecord {
  status: IdempotencyRecordStatus;
  /** SHA-256 of method+path+body, used to detect key reuse with a different payload. */
  fingerprint: string;
  response?: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  createdAt: number;
}

/**
 * Storage interface for idempotency records. The in-memory implementation
 * below is for local dev and tests only — it does not survive a process
 * restart or work across multiple service instances, which real
 * idempotency guarantees require. Production services (payment-engine in
 * particular) MUST supply a shared store (Redis, keyed with a TTL) that
 * implements this same interface. That Redis-backed implementation is not
 * part of this package's scope — see README "Known gaps".
 */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>;
  /** Sets a record only if the key does not already exist. Returns false if it did (race lost). */
  setIfAbsent(key: string, record: IdempotencyRecord): Promise<boolean>;
  set(key: string, record: IdempotencyRecord): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  private isExpired(record: IdempotencyRecord): boolean {
    return Date.now() - record.createdAt > this.ttlMs;
  }

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    const record = this.records.get(key);
    if (!record) return undefined;
    if (this.isExpired(record)) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  async setIfAbsent(key: string, record: IdempotencyRecord): Promise<boolean> {
    const existing = await this.get(key);
    if (existing) return false;
    this.records.set(key, record);
    return true;
  }

  async set(key: string, record: IdempotencyRecord): Promise<void> {
    this.records.set(key, record);
  }

  /** Test/inspection helper. */
  size(): number {
    return this.records.size;
  }
}

export function fingerprintRequest(method: string, path: string, body: unknown): string {
  const hash = createHash("sha256");
  hash.update(method.toUpperCase());
  hash.update("\n");
  hash.update(path);
  hash.update("\n");
  hash.update(body === undefined ? "" : JSON.stringify(body));
  return hash.digest("hex");
}

export interface IdempotencyOptions {
  store: IdempotencyStore;
  /** Methods this middleware enforces an Idempotency-Key on. Default: POST, PATCH. */
  methods?: string[];
  headerName?: string;
  hooks?: HttpLogHooks;
}

/**
 * Express middleware enforcing idempotency-key semantics on mutating
 * requests:
 *  - Missing key on an enforced method -> IDEMPOTENCY_KEY_REQUIRED (400).
 *  - Same key reused with a different method/path/body -> IDEMPOTENCY_KEY_REPLAY_MISMATCH (422),
 *    since silently reusing the client's original response for a different
 *    payload would be worse than rejecting it.
 *  - Same key + same fingerprint, prior request still in flight -> CONFLICT (409).
 *  - Same key + same fingerprint, prior request completed -> the original
 *    response is replayed byte-for-byte, and the handler is never invoked again.
 */
export function idempotency(options: IdempotencyOptions): RequestHandler {
  const { store, headerName = IDEMPOTENCY_KEY_HEADER, hooks } = options;
  const methods = new Set((options.methods ?? ["POST", "PATCH"]).map((m) => m.toUpperCase()));

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!methods.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const key = req.header(headerName);
    if (!key) {
      next(new ApiError("IDEMPOTENCY_KEY_REQUIRED", `Missing required '${headerName}' header for ${req.method} requests.`));
      return;
    }

    // shared-types defines the key as a UUID (IdempotencyKeySchema). Reject
    // malformed keys explicitly rather than silently treating them as a
    // fresh, never-seen key — a client sending "abc123" every retry would
    // otherwise get zero idempotency protection without any error telling them why.
    const keyCheck = IdempotencyKeySchema.safeParse(key);
    if (!keyCheck.success) {
      next(
        new ApiError(
          "IDEMPOTENCY_KEY_INVALID",
          `The '${headerName}' header must be a valid UUID.`,
          { details: { issues: keyCheck.error.issues.map((i) => ({ path: headerName, message: i.message })) } },
        ),
      );
      return;
    }

    const fingerprint = fingerprintRequest(req.method, req.originalUrl ?? req.url, req.body);
    const existing = await store.get(key);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        next(
          new ApiError(
            "IDEMPOTENCY_KEY_REPLAY_MISMATCH",
            "This idempotency key was already used with a different request payload.",
          ),
        );
        return;
      }

      if (existing.status === "in-flight") {
        next(new ApiError("CONFLICT", "A request with this idempotency key is already being processed."));
        return;
      }

      // Completed — replay the original response verbatim, handler never re-runs.
      const { response } = existing;
      if (response) {
        for (const [headerKey, value] of Object.entries(response.headers)) {
          res.setHeader(headerKey, value);
        }
        res.setHeader("Idempotent-Replay", "true");
        res.status(response.status).json(response.body);
      }
      return;
    }

    const claimed = await store.setIfAbsent(key, { status: "in-flight", fingerprint, createdAt: Date.now() });
    if (!claimed) {
      // Lost a race against a concurrent request with the same key.
      next(new ApiError("CONFLICT", "A request with this idempotency key is already being processed."));
      return;
    }

    // Capture the eventual response so it can be stored + replayed later.
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      void store.set(key, {
        status: "completed",
        fingerprint,
        createdAt: Date.now(),
        response: {
          status: res.statusCode,
          headers: { "content-type": "application/json" },
          body,
        },
      });
      return originalJson(body);
    }) as Response["json"];

    hooks?.onRequestStart?.({ method: req.method, path: req.path, requestId: key });
    next();
  };
}
