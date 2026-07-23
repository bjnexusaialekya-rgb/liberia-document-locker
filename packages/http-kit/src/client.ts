import { randomUUID } from "node:crypto";
import { IDEMPOTENCY_KEY_HEADER, type ApiErrorShape } from "@liberia-locker/shared-types";
import { ApiError, toApiError } from "./errors.js";
import type { HttpLogHooks } from "./logging.js";
import { withRetry, type RetryOptions } from "./retry.js";

export interface HttpClientOptions {
  baseUrl: string;
  /** Default headers sent with every request (e.g. service auth). */
  defaultHeaders?: Record<string, string>;
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  retry?: RetryOptions;
  hooks?: HttpLogHooks;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Auto-generates and attaches an Idempotency-Key header for mutating
   * requests unless one is already provided in `headers`. Defaults to true
   * for POST/PATCH, false otherwise — set explicitly to override.
   */
  idempotent?: boolean;
  timeoutMs?: number;
  retry?: RetryOptions;
}

class UpstreamHttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Thin wrapper around fetch shared by every service for calling other
 * services: consistent timeout handling, retry/backoff, idempotency-key
 * injection for mutating calls, and logging hooks — so no service
 * hand-rolls its own inconsistent version of these.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retryOptions: RetryOptions | undefined;
  private readonly hooks: HttpLogHooks | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retryOptions = options.retry;
    this.hooks = options.hooks;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const method = options.method ?? "GET";
    const url = `${this.baseUrl}${options.path.startsWith("/") ? "" : "/"}${options.path}`;
    const requestId = randomUUID();

    const shouldAutoIdempotency = options.idempotent ?? (method === "POST" || method === "PATCH");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-request-id": requestId,
      ...this.defaultHeaders,
      ...options.headers,
    };
    const hasIdempotencyHeader = Object.keys(headers).some(
      (h) => h.toLowerCase() === IDEMPOTENCY_KEY_HEADER.toLowerCase(),
    );
    if (shouldAutoIdempotency && !hasIdempotencyHeader) {
      headers[IDEMPOTENCY_KEY_HEADER] = randomUUID();
    }

    this.hooks?.onRequestStart?.({ method, path: options.path, requestId });
    const startedAt = Date.now();

    try {
      const mergedRetry: RetryOptions = { ...this.retryOptions, ...options.retry };
      if (this.hooks) mergedRetry.hooks = this.hooks;
      const result = await withRetry<T>(
        async () => this.attemptOnce<T>(method, url, headers, options.body, options.timeoutMs ?? this.timeoutMs),
        mergedRetry,
      );
      this.hooks?.onRequestEnd?.({
        method,
        path: options.path,
        requestId,
        status: 200,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const apiError = this.toClientApiError(error);
      this.hooks?.onError?.({
        requestId,
        code: apiError.code,
        message: apiError.message,
        status: apiError.status,
        cause: apiError.cause,
      });
      throw apiError;
    }
  }

  private async attemptOnce<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await this.fetchImpl(url, init);

      const text = await response.text();
      const parsed = text ? safeJsonParse(text) : undefined;

      if (!response.ok) {
        throw new UpstreamHttpError(response.status, `Upstream responded ${response.status}`, parsed);
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new UpstreamHttpError(504, `Request timed out after ${timeoutMs}ms`, undefined);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toClientApiError(error: unknown): ApiError {
    if (error instanceof UpstreamHttpError) {
      const body = error.body as Partial<ApiErrorShape> | undefined;
      if (body?.error?.code) {
        // Upstream already spoke http-kit's standard error shape — surface it as-is.
        const options: { details?: Record<string, unknown> } = {};
        if (body.error.details) options.details = body.error.details;
        return new ApiError(body.error.code, body.error.message, options);
      }
      if (error.status === 504) return new ApiError("UPSTREAM_TIMEOUT", error.message);
      if (error.status >= 500 || error.status === 429) return new ApiError("UPSTREAM_UNAVAILABLE", error.message, { cause: error });
      return ApiError.internal(`Unexpected upstream response (${error.status}) with a non-standard error body.`, error);
    }
    return toApiError(error);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
