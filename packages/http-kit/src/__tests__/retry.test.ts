import { describe, expect, it, vi } from "vitest";
import { computeBackoffMs, defaultShouldRetry, withRetry } from "../retry.js";

describe("computeBackoffMs", () => {
  it("stays within [0, min(maxDelayMs, base * 2^attempt)]", () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const delay = computeBackoffMs(attempt, 100, 5000);
      const cap = Math.min(5000, 100 * 2 ** attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(cap);
    }
  });

  it("respects the maxDelayMs cap even at high attempt counts", () => {
    const delay = computeBackoffMs(20, 100, 1000);
    expect(delay).toBeLessThanOrEqual(1000);
  });
});

describe("defaultShouldRetry", () => {
  it("retries unknown/network-shaped errors", () => {
    expect(defaultShouldRetry(new Error("ECONNRESET"))).toBe(true);
  });

  it("retries 5xx and 429", () => {
    expect(defaultShouldRetry({ status: 500 })).toBe(true);
    expect(defaultShouldRetry({ status: 503 })).toBe(true);
    expect(defaultShouldRetry({ status: 429 })).toBe(true);
  });

  it("does not retry other 4xx", () => {
    expect(defaultShouldRetry({ status: 400 })).toBe(false);
    expect(defaultShouldRetry({ status: 404 })).toBe(false);
    expect(defaultShouldRetry({ status: 422 })).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { sleep: async () => {} });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures up to maxAttempts, then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw { status: 503 };
      return "eventually ok";
    });

    const result = await withRetry(fn, { maxAttempts: 5, sleep: async () => {} });
    expect(result).toBe("eventually ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 503 });
    await expect(withRetry(fn, { maxAttempts: 3, sleep: async () => {} })).rejects.toEqual({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error, even on attempt 1", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 });
    await expect(withRetry(fn, { maxAttempts: 5, sleep: async () => {} })).rejects.toEqual({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry hook with attempt/delay/reason before each retry sleep", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 2) throw new Error("flaky");
      return "ok";
    });

    await withRetry(fn, { maxAttempts: 3, sleep: async () => {}, hooks: { onRetry } });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, maxAttempts: 3, reason: "flaky" });
  });
});
