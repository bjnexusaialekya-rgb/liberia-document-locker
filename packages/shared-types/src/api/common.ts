import { z } from "zod";

/**
 * Standard error shape every service returns (Phase 0 shared middleware library).
 * Kept deliberately small and stable — every one of the 14 services and 3 apps
 * can parse this without knowing which service produced it.
 */
export interface ApiErrorShape {
  error: {
    code: string; // stable machine-readable code, e.g. "CONSENT_NOT_ACTIVE"
    message: string; // human-readable, safe to show to a caller
    requestId: string; // correlates to a specific audit-log / log-line trace
    details?: Record<string, unknown>;
  };
}

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.record(z.unknown()).optional(),
  }),
});

export interface PaginationParams {
  page: number; // 1-indexed
  pageSize: number;
}

export const PaginationParamsSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export function paginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    totalItems: z.number().int().min(0),
    totalPages: z.number().int().min(0),
  });
}

/**
 * Every mutating request that touches payment-engine (and, per Phase 0's shared
 * middleware, any other mutating endpoint that opts in) must carry this header.
 * packages/http-kit enforces it; this is the shared shape both client and
 * server sides import so the header name/casing never drifts between services.
 */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key" as const;

export const IdempotencyKeySchema = z.string().uuid();
