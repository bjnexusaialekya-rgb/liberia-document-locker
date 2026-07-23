import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors.js";
import { asyncHandler, errorHandler, requestId, sendSuccess } from "../server.js";

function buildApp() {
  const app = express();
  app.use(requestId());

  app.get("/ok", (req, res) => sendSuccess(req, res, { hello: "world" }));

  app.get("/known-error", () => {
    throw ApiError.notFound("Document not found.");
  });

  app.get("/unknown-error", () => {
    throw new Error("something leaked from a driver");
  });

  app.get(
    "/async-rejects",
    asyncHandler(async () => {
      throw ApiError.forbidden("nope");
    }),
  );

  app.use(errorHandler());
  return app;
}

describe("requestId + sendSuccess", () => {
  it("mints a request id, echoes it on the response, and wraps data in the success envelope", async () => {
    const res = await request(buildApp()).get("/ok");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ hello: "world" });
    expect(typeof res.body.requestId).toBe("string");
    expect(res.headers["x-request-id"]).toBe(res.body.requestId);
  });

  it("reuses an inbound x-request-id instead of minting a new one", async () => {
    const res = await request(buildApp()).get("/ok").set("x-request-id", "trace-abc-123");
    expect(res.headers["x-request-id"]).toBe("trace-abc-123");
    expect(res.body.requestId).toBe("trace-abc-123");
  });
});

describe("errorHandler", () => {
  it("serializes a known ApiError with its real status and code", async () => {
    const res = await request(buildApp()).get("/known-error");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.message).toBe("Document not found.");
  });

  it("maps an unexpected thrown Error to a generic INTERNAL_ERROR without leaking its message", async () => {
    const res = await request(buildApp()).get("/unknown-error");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("driver");
  });

  it("catches rejected promises from asyncHandler-wrapped routes", async () => {
    const res = await request(buildApp()).get("/async-rejects");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("invokes the onError hook with request id, code, and status", async () => {
    const onError = vi.fn();
    const app = express();
    app.use(requestId());
    app.get("/boom", () => {
      throw ApiError.conflict("dup");
    });
    app.use(errorHandler({ onError }));

    await request(app).get("/boom");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ code: "CONFLICT", status: 409 });
  });
});
