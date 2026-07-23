import express from "express";
import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, requestId } from "../server.js";
import { InMemoryIdempotencyStore, fingerprintRequest, idempotency } from "../idempotency.js";

function buildApp(store: InMemoryIdempotencyStore, handlerCalls: { count: number }): Express {
  const app = express();
  app.use(express.json());
  app.use(requestId());
  app.use(idempotency({ store }));

  app.post("/payments", (req, res) => {
    handlerCalls.count += 1;
    res.status(201).json({ id: "pay_1", amount: req.body.amount });
  });

  app.get("/payments/:id", (req, res) => {
    handlerCalls.count += 1;
    res.status(200).json({ id: req.params.id });
  });

  app.use(errorHandler());
  return app;
}

describe("fingerprintRequest", () => {
  it("is stable for identical inputs and differs when the body differs", () => {
    const a = fingerprintRequest("POST", "/payments", { amount: 10 });
    const b = fingerprintRequest("POST", "/payments", { amount: 10 });
    const c = fingerprintRequest("POST", "/payments", { amount: 20 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("idempotency middleware", () => {
  let store: InMemoryIdempotencyStore;
  let handlerCalls: { count: number };
  let app: Express;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
    handlerCalls = { count: 0 };
    app = buildApp(store, handlerCalls);
  });

  it("passes through non-enforced methods (GET) without requiring a key", async () => {
    const res = await request(app).get("/payments/pay_1");
    expect(res.status).toBe(200);
    expect(handlerCalls.count).toBe(1);
  });

  it("rejects a POST with no Idempotency-Key header", async () => {
    const res = await request(app).post("/payments").send({ amount: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(handlerCalls.count).toBe(0);
  });

  it("rejects an Idempotency-Key that isn't a valid UUID (shared-types' IdempotencyKeySchema)", async () => {
    const res = await request(app).post("/payments").set("Idempotency-Key", "not-a-uuid").send({ amount: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(handlerCalls.count).toBe(0);
  });

  it("processes a fresh key normally and only calls the handler once", async () => {
    const res = await request(app)
      .post("/payments")
      .set("Idempotency-Key", "11111111-1111-4111-8111-111111111111")
      .send({ amount: 10 });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("pay_1");
    expect(handlerCalls.count).toBe(1);
  });

  it("replays the stored response on retry with the same key + same payload, without re-invoking the handler", async () => {
    const first = await request(app).post("/payments").set("Idempotency-Key", "22222222-2222-4222-8222-222222222222").send({ amount: 50 });
    const second = await request(app).post("/payments").set("Idempotency-Key", "22222222-2222-4222-8222-222222222222").send({ amount: 50 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(handlerCalls.count).toBe(1); // handler only ran once
  });

  it("rejects reuse of the same key with a different payload", async () => {
    await request(app).post("/payments").set("Idempotency-Key", "33333333-3333-4333-8333-333333333333").send({ amount: 10 });
    const mismatch = await request(app).post("/payments").set("Idempotency-Key", "33333333-3333-4333-8333-333333333333").send({ amount: 999 });

    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe("IDEMPOTENCY_KEY_REPLAY_MISMATCH");
    expect(handlerCalls.count).toBe(1); // second call never reached the handler
  });

  it("rejects a concurrent request with the same key while the first is still in-flight", async () => {
    const claimed = await store.setIfAbsent("44444444-4444-4444-8444-444444444444", {
      status: "in-flight",
      fingerprint: fingerprintRequest("POST", "/payments", { amount: 5 }),
      createdAt: Date.now(),
    });
    expect(claimed).toBe(true);

    const res = await request(app).post("/payments").set("Idempotency-Key", "44444444-4444-4444-8444-444444444444").send({ amount: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(handlerCalls.count).toBe(0);
  });
});

describe("InMemoryIdempotencyStore TTL", () => {
  it("expires records after the configured TTL", async () => {
    vi.useFakeTimers();
    const store = new InMemoryIdempotencyStore(1000);
    await store.set("k", { status: "completed", fingerprint: "f", createdAt: Date.now() });
    expect(await store.get("k")).toBeDefined();

    vi.advanceTimersByTime(1500);
    expect(await store.get("k")).toBeUndefined();
    vi.useRealTimers();
  });
});
