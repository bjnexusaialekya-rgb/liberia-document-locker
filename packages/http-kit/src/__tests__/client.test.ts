import { describe, expect, it, vi } from "vitest";
import { HttpClient } from "../client.js";
import { ApiError } from "../errors.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpClient", () => {
  it("resolves with the parsed JSON body on a 2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = new HttpClient({ baseUrl: "https://svc.internal", fetchImpl });

    const result = await client.request<{ ok: boolean }>({ path: "/things", method: "GET" });
    expect(result).toEqual({ ok: true });
  });

  it("auto-injects an Idempotency-Key header on POST when the caller didn't supply one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: "1" }));
    const client = new HttpClient({ baseUrl: "https://svc.internal", fetchImpl });

    await client.request({ path: "/things", method: "POST", body: { name: "x" } });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeDefined();
  });

  it("does not override a caller-supplied Idempotency-Key header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: "1" }));
    const client = new HttpClient({ baseUrl: "https://svc.internal", fetchImpl });

    await client.request({
      path: "/things",
      method: "POST",
      body: { name: "x" },
      headers: { "Idempotency-Key": "22222222-2222-4222-8222-222222222222" },
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("does not auto-inject an idempotency key on GET requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const client = new HttpClient({ baseUrl: "https://svc.internal", fetchImpl });

    await client.request({ path: "/things/1", method: "GET" });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("retries a 503 and succeeds on a later attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: "UPSTREAM_UNAVAILABLE", message: "down" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const client = new HttpClient({
      baseUrl: "https://svc.internal",
      fetchImpl,
      retry: { maxAttempts: 3, sleep: async () => {} },
    });

    const result = await client.request<{ ok: boolean }>({ path: "/flaky", method: "GET" });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 404 and surfaces it as an ApiError", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { error: { code: "NOT_FOUND", message: "Document not found." } }));

    const client = new HttpClient({
      baseUrl: "https://svc.internal",
      fetchImpl,
      retry: { maxAttempts: 3, sleep: async () => {} },
    });

    await expect(client.request({ path: "/missing", method: "GET" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps an aborted (timeout) request to UPSTREAM_TIMEOUT", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });

    const client = new HttpClient({
      baseUrl: "https://svc.internal",
      fetchImpl,
      timeoutMs: 5,
      retry: { maxAttempts: 1, sleep: async () => {} },
    });

    await expect(client.request({ path: "/slow", method: "GET" })).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });
  });

  it("wraps a non-standard error body from upstream as INTERNAL_ERROR rather than crashing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );
    const client = new HttpClient({
      baseUrl: "https://svc.internal",
      fetchImpl,
      retry: { maxAttempts: 1, sleep: async () => {} },
    });

    const err = await client.request({ path: "/broken", method: "GET" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBeGreaterThanOrEqual(500);
  });
});
