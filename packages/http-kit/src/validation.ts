import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";
import { ApiError } from "./errors.js";

export interface ValidationSchemas {
  body?: ZodType<unknown>;
  query?: ZodType<unknown>;
  params?: ZodType<unknown>;
  headers?: ZodType<unknown>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by validateRequest() with the *parsed* (not raw) values. */
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
        headers?: unknown;
      };
    }
  }
}

/**
 * Express middleware factory: validates body/query/params/headers against
 * zod schemas and rewrites req fields with the parsed (coerced, defaulted)
 * output rather than the raw input. On failure, throws ApiError.validation
 * with every field-level issue collected — not just the first one — so
 * clients can fix a request in one round trip instead of iterating.
 *
 * Requires an error-handling middleware downstream (see server.ts
 * `errorHandler`) to turn the thrown ApiError into a response.
 */
export function validateRequest(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const issues: Array<{ path: string; message: string }> = [];
    const validated: NonNullable<Request["validated"]> = {};

    for (const key of ["body", "query", "params", "headers"] as const) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (result.success) {
        validated[key] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ path: `${key}.${issue.path.join(".") || "<root>"}`, message: issue.message });
        }
      }
    }

    if (issues.length > 0) {
      next(ApiError.validation(issues));
      return;
    }

    req.validated = validated;
    next();
  };
}
