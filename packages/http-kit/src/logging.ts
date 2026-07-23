/**
 * Logging hooks. http-kit never picks a logging backend for you — every
 * service wires in its own (pino, winston, console, whatever) by
 * implementing this interface. Default is a redacting console logger so
 * the package is usable standalone in tests and local dev.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

/** Field names that are redacted by the default logger before printing. */
const DEFAULT_REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "idempotencyKey",
  "ssn",
  "nationalId",
]);

export function redact(fields: LogFields, redactedKeys: Set<string> = DEFAULT_REDACTED_KEYS): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redactedKeys.has(key.toLowerCase()) || redactedKeys.has(key) ? "[REDACTED]" : value;
  }
  return out;
}

/**
 * Minimal console-based logger. Suitable for local dev/tests; production
 * services are expected to supply their own Logger (e.g. wrapping pino)
 * so logs are structured/shipped correctly — this default intentionally
 * does not try to be that.
 */
export const consoleLogger: Logger = {
  log(level, message, fields = {}) {
    const line = { level, message, ...redact(fields), time: new Date().toISOString() };
    const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    out(JSON.stringify(line));
  },
};

/** No-op logger, useful for tests that don't want log noise. */
export const noopLogger: Logger = {
  log() {
    /* intentionally empty */
  },
};

export interface HttpLogHooks {
  /** Called once a request is received, before validation/handling. */
  onRequestStart?(info: { method: string; path: string; requestId: string }): void;
  /** Called once a response is about to be sent. */
  onRequestEnd?(info: {
    method: string;
    path: string;
    requestId: string;
    status: number;
    durationMs: number;
  }): void;
  /** Called whenever a handler throws / an ApiError is produced. */
  onError?(info: { requestId: string; code: string; message: string; status: number; cause?: unknown }): void;
  /** Called on each retry attempt made by the HTTP client. */
  onRetry?(info: { attempt: number; maxAttempts: number; delayMs: number; reason: string }): void;
}

/** Builds HttpLogHooks backed by a Logger, so services only need to supply a Logger. */
export function hooksFromLogger(logger: Logger): HttpLogHooks {
  return {
    onRequestStart({ method, path, requestId }) {
      logger.log("debug", "request.start", { method, path, requestId });
    },
    onRequestEnd({ method, path, requestId, status, durationMs }) {
      logger.log("info", "request.end", { method, path, requestId, status, durationMs });
    },
    onError({ requestId, code, message, status, cause }) {
      logger.log(status >= 500 ? "error" : "warn", "request.error", {
        requestId,
        code,
        message,
        status,
        cause: cause instanceof Error ? cause.stack : cause,
      });
    },
    onRetry({ attempt, maxAttempts, delayMs, reason }) {
      logger.log("warn", "http_client.retry", { attempt, maxAttempts, delayMs, reason });
    },
  };
}
