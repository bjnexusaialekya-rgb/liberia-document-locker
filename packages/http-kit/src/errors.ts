import type { ApiErrorShape } from "@liberia-locker/shared-types";

/**
 * "Well-known" codes http-kit assigns a default HTTP status to. This is
 * NOT a closed set — shared-types defines `code` as a plain `string`
 * (services mint their own, e.g. "CONSENT_NOT_ACTIVE") — so ApiError
 * accepts any string code. This map just saves every service from having
 * to repeat `{ status: 404 }` for the common cases, and gives one place
 * that decides "CONFLICT is 409" platform-wide.
 */
export type WellKnownErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_KEY_REPLAY_MISMATCH"
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "INTERNAL_ERROR";

export const ERROR_CODE_STATUS: Record<WellKnownErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_KEY_REPLAY_MISMATCH: 422,
  RATE_LIMITED: 429,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_UNAVAILABLE: 502,
  INTERNAL_ERROR: 500,
};

function isWellKnown(code: string): code is WellKnownErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODE_STATUS, code);
}

export interface ApiErrorOptions {
  /** Matches shared-types' `ApiErrorShape.error.details: Record<string, unknown>`. */
  details?: Record<string, unknown> | undefined;
  /** Required for any code not in WellKnownErrorCode — there's no default to fall back on. */
  status?: number | undefined;
  /** Underlying cause, kept off the wire, available for logging hooks. */
  cause?: unknown;
}

/**
 * The one error class every service should throw for anything that needs
 * to reach a client as a structured response, matching shared-types'
 * ApiErrorShape exactly. Anything else thrown is treated as an unexpected
 * bug and mapped to INTERNAL_ERROR by the error-handling middleware,
 * never leaked verbatim.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown> | undefined;
  override readonly cause?: unknown;

  constructor(code: WellKnownErrorCode | (string & {}), message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = options.status ?? (isWellKnown(code) ? ERROR_CODE_STATUS[code] : 500);
    this.details = options.details;
    this.cause = options.cause;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  static validation(issues: Array<{ path: string; message: string }>): ApiError {
    return new ApiError("VALIDATION_ERROR", "Request failed validation.", { details: { issues } });
  }

  static notFound(message = "Resource not found."): ApiError {
    return new ApiError("NOT_FOUND", message);
  }

  static unauthorized(message = "Authentication required."): ApiError {
    return new ApiError("UNAUTHORIZED", message);
  }

  static forbidden(message = "Not permitted to perform this action."): ApiError {
    return new ApiError("FORBIDDEN", message);
  }

  static conflict(message: string): ApiError {
    return new ApiError("CONFLICT", message);
  }

  static internal(message = "An unexpected error occurred.", cause?: unknown): ApiError {
    return new ApiError("INTERNAL_ERROR", message, { cause });
  }

  /**
   * A service-specific error not in WellKnownErrorCode — e.g.
   * ApiError.custom("CONSENT_NOT_ACTIVE", 409, "Consent grant is not active.").
   * `status` is required here since there's no platform-wide default for it.
   */
  static custom(code: string, status: number, message: string, options: Omit<ApiErrorOptions, "status"> = {}): ApiError {
    return new ApiError(code, message, { ...options, status });
  }

  /** Serializes to the exact shared-types ApiErrorShape wire shape. Never includes `cause`. */
  toJSON(requestId: string): ApiErrorShape {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** True for any error object that already carries a structured API shape. */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/**
 * Normalizes an arbitrary thrown value into an ApiError. Anything not
 * already an ApiError is treated as INTERNAL_ERROR with a deliberately
 * generic message — the original message/stack may contain internals
 * (SQL, file paths, stack frames) and is only kept on `cause`, which
 * callers must route to logging, never to a response.
 */
export function toApiError(err: unknown): ApiError {
  if (isApiError(err)) return err;
  return ApiError.internal("An unexpected error occurred.", err);
}
