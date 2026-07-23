import { describe, expect, it } from "vitest";
import { ApiError, isApiError, toApiError } from "../errors.js";

describe("ApiError", () => {
  it("maps codes to the correct standard HTTP status", () => {
    expect(ApiError.notFound().status).toBe(404);
    expect(ApiError.unauthorized().status).toBe(401);
    expect(ApiError.forbidden().status).toBe(403);
    expect(ApiError.conflict("x").status).toBe(409);
    expect(ApiError.internal().status).toBe(500);
    expect(new ApiError("RATE_LIMITED", "slow down").status).toBe(429);
  });

  it("serializes to the standard wire shape without leaking `cause`", () => {
    const err = ApiError.internal("boom", new Error("secret internals"));
    const json = err.toJSON("req-123");
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(json.error.message).toBe("boom");
    expect(json.error.requestId).toBe("req-123");
    expect(JSON.stringify(json)).not.toContain("secret internals");
  });

  it("carries validation details through to JSON as { issues } (shared-types details is Record<string, unknown>, not an array)", () => {
    const err = ApiError.validation([{ path: "body.email", message: "Invalid email" }]);
    const json = err.toJSON("req-1");
    expect(json.error.details).toEqual({ issues: [{ path: "body.email", message: "Invalid email" }] });
  });
});

describe("isApiError / toApiError", () => {
  it("identifies ApiError instances", () => {
    expect(isApiError(ApiError.notFound())).toBe(true);
    expect(isApiError(new Error("nope"))).toBe(false);
    expect(isApiError("nope")).toBe(false);
  });

  it("passes through an existing ApiError unchanged", () => {
    const original = ApiError.conflict("dup");
    expect(toApiError(original)).toBe(original);
  });

  it("wraps a plain Error as INTERNAL_ERROR with a generic message, keeping the original only on `cause`", () => {
    const original = new Error("db connection lost");
    const wrapped = toApiError(original);
    expect(wrapped.code).toBe("INTERNAL_ERROR");
    expect(wrapped.message).not.toContain("db connection lost");
    expect(wrapped.cause).toBe(original);
  });

  it("wraps a non-Error thrown value as INTERNAL_ERROR without crashing", () => {
    const wrapped = toApiError("some string was thrown");
    expect(wrapped.code).toBe("INTERNAL_ERROR");
  });
});
