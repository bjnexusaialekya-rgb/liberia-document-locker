import type { HttpLogHooks } from "./logging.js";

export interface RetryOptions {
  /** Total attempts including the first (non-retry) one. Default 3. */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default 200. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms, before jitter. Default 5000. */
  maxDelayMs?: number;
  /** Called before sleeping, for logging/metrics. */
  hooks?: HttpLogHooks;
  /** Decides whether a given error is worth retrying. Default: retryDefault below. */
  shouldRetry?(error: unknown, attempt: number): boolean;
  /** Injectable sleep, overridden in tests to avoid real delays. */
  sleep?(ms: number): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full-jitter exponential backoff: delay = random(0, min(maxDelayMs, base * 2^attempt)).
 * Full jitter (rather than fixed or equal jitter) avoids retry storms when
 * many callers back off in lockstep after a shared dependency blips.
 */
export function computeBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * cap);
}

/** Marks an error as one that carries an HTTP-like status, for the default retry predicate. */
export interface HttpLikeError {
  status?: number;
  code?: string;
}

function hasHttpLikeShape(error: unknown): error is HttpLikeError {
  return typeof error === "object" && error !== null && ("status" in error || "code" in error);
}

/**
 * Default retry predicate: retry network-level failures and 5xx/429
 * responses; never retry 4xx (other than 429) since those indicate the
 * request itself is wrong and retrying it will just fail again identically.
 */
export function defaultShouldRetry(error: unknown): boolean {
  if (!hasHttpLikeShape(error)) return true; // unknown/network error — assume transient
  if (error.status === undefined) return true; // e.g. ECONNRESET, fetch TypeError
  if (error.status === 429) return true;
  if (error.status >= 500) return true;
  return false;
}

/**
 * Runs `fn`, retrying on failure per `shouldRetry`, with exponential
 * backoff + full jitter between attempts. Throws the last error if all
 * attempts are exhausted.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt || !shouldRetry(error, attempt)) {
        throw error;
      }
      const delayMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
      options.hooks?.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        reason: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs);
    }
  }

  // Unreachable given the loop above always returns or throws, but keeps TS happy.
  throw lastError;
}
