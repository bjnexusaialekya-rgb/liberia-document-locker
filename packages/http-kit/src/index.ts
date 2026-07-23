export {
  ApiError,
  ERROR_CODE_STATUS,
  isApiError,
  toApiError,
  type ApiErrorOptions,
  type WellKnownErrorCode,
} from "./errors.js";

export {
  consoleLogger,
  noopLogger,
  hooksFromLogger,
  redact,
  type Logger,
  type LogLevel,
  type LogFields,
  type HttpLogHooks,
} from "./logging.js";

export { validateRequest, type ValidationSchemas } from "./validation.js";

export {
  idempotency,
  InMemoryIdempotencyStore,
  fingerprintRequest,
  type IdempotencyStore,
  type IdempotencyRecord,
  type IdempotencyRecordStatus,
  type IdempotencyOptions,
} from "./idempotency.js";

export {
  withRetry,
  computeBackoffMs,
  defaultShouldRetry,
  type RetryOptions,
  type HttpLikeError,
} from "./retry.js";

export { HttpClient, type HttpClientOptions, type RequestOptions } from "./client.js";

export {
  requestId,
  sendSuccess,
  errorHandler,
  asyncHandler,
  requestLogging,
  type ApiSuccessEnvelope,
} from "./server.js";

// Re-exported for convenience so consumers of http-kit don't need a
// separate direct dependency on shared-types just to reference these.
export type { ApiErrorShape } from "@liberia-locker/shared-types";
export { IDEMPOTENCY_KEY_HEADER, IdempotencyKeySchema } from "@liberia-locker/shared-types";
