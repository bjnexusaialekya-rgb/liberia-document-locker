import { describe, it, expect } from "vitest";
import { splitSecret, reconstructSecret, verifySplit } from "../src/shamir";
import { InsufficientSharesError, ShamirParameterError } from "../src/errors";

describe("shamir: split/reconstruct roundtrip", () => {
  it("reconstructs an exact threshold subset of shares", () => {
    const secret = Buffer.from("correct-horse-battery-staple", "utf8");
    const shares = splitSecret(secret, { shares: 5, threshold: 3 });
    expect(shares).toHaveLength(5);

    const subset = [shares[0], shares[2], shares[4]];
    const reconstructed = reconstructSecret(subset, 3);
    expect(reconstructed.equals(secret)).toBe(true);
  });

  it("reconstructs correctly regardless of which threshold-sized subset is used", () => {
    const secret = randomLikeBuffer(32);
    const shares = splitSecret(secret, { shares: 5, threshold: 3 });

    const combos = [
      [shares[0], shares[1], shares[2]],
      [shares[1], shares[3], shares[4]],
      [shares[0], shares[2], shares[4]],
    ];
    for (const combo of combos) {
      expect(reconstructSecret(combo).equals(secret)).toBe(true);
    }
  });

  it("works with more than threshold shares supplied", () => {
    const secret = Buffer.from("all five shares supplied", "utf8");
    const shares = splitSecret(secret, { shares: 5, threshold: 3 });
    expect(reconstructSecret(shares).equals(secret)).toBe(true);
  });

  it("handles single-byte and long secrets", () => {
    for (const len of [1, 2, 16, 32, 64, 256]) {
      const secret = randomLikeBuffer(len);
      const shares = splitSecret(secret, { shares: 5, threshold: 3 });
      const reconstructed = reconstructSecret(shares.slice(0, 3));
      expect(reconstructed.equals(secret)).toBe(true);
    }
  });

  it("verifySplit self-check passes for a valid split", () => {
    const secret = Buffer.from("blueprint default: 5 shares, 3-of-5", "utf8");
    const shares = splitSecret(secret, { shares: 5, threshold: 3 });
    expect(verifySplit(secret, shares, 3)).toBe(true);
  });
});

describe("shamir: threshold is actually enforced", () => {
  it("throws InsufficientSharesError when fewer than the threshold are given (with expectedThreshold passed)", () => {
    const secret = Buffer.from("secret", "utf8");
    const shares = splitSecret(secret, { shares: 5, threshold: 3 });
    expect(() => reconstructSecret(shares.slice(0, 2), 3)).toThrow(InsufficientSharesError);
  });

  it("fewer-than-threshold shares reconstruct to garbage, not the real secret, when threshold isn't asserted", () => {
    // Demonstrates the actual cryptographic property (not just the guard clause):
    // 2 shares of a 3-of-5 scheme underdetermine the secret.
    const secret = Buffer.from("do not reveal me with 2 shares", "utf8");
    const shares = splitSecret(secret, { shares: 5, threshold: 3 });
    const reconstructedWithTooFew = reconstructSecret(shares.slice(0, 2));
    expect(reconstructedWithTooFew.equals(secret)).toBe(false);
  });
});

describe("shamir: parameter validation", () => {
  it("rejects threshold < 2", () => {
    expect(() => splitSecret(Buffer.from("x"), { shares: 5, threshold: 1 })).toThrow(ShamirParameterError);
  });

  it("rejects shares < threshold", () => {
    expect(() => splitSecret(Buffer.from("x"), { shares: 2, threshold: 3 })).toThrow(ShamirParameterError);
  });

  it("rejects an empty secret", () => {
    expect(() => splitSecret(Buffer.alloc(0), { shares: 5, threshold: 3 })).toThrow(ShamirParameterError);
  });

  it("rejects more than 255 shares (GF(256) x-coordinate space)", () => {
    expect(() => splitSecret(Buffer.from("x"), { shares: 300, threshold: 3 })).toThrow(ShamirParameterError);
  });

  it("reconstructSecret rejects a duplicate x-coordinate", () => {
    const secret = Buffer.from("dup test", "utf8");
    const shares = splitSecret(secret, { shares: 5, threshold: 3 });
    const dup = [shares[0] as (typeof shares)[number], shares[0] as (typeof shares)[number], shares[1] as (typeof shares)[number]];
    expect(() => reconstructSecret(dup)).toThrow(ShamirParameterError);
  });

  it("reconstructSecret rejects mismatched share lengths", () => {
    const a = splitSecret(Buffer.from("aaaa"), { shares: 3, threshold: 2 });
    const b = splitSecret(Buffer.from("bb"), { shares: 3, threshold: 2 });
    expect(() => reconstructSecret([a[0] as (typeof a)[number], b[1] as (typeof b)[number]])).toThrow(
      ShamirParameterError,
    );
  });
});

describe("shamir: blueprint default scheme (5 shares, 3-of-5)", () => {
  it("matches the exact scheme named in the master blueprint for the production unseal handover", () => {
    const secret = randomLikeBuffer(32); // Vault unseal shares are typically this size
    const shares = splitSecret(secret, { shares: 5, threshold: 3 });
    expect(shares).toHaveLength(5);
    expect(new Set(shares.map((s) => s.x)).size).toBe(5); // all distinct x-coordinates
    expect(reconstructSecret(shares.slice(0, 3), 3).equals(secret)).toBe(true);
  });
});

function randomLikeBuffer(len: number): Buffer {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = (i * 37 + 11) % 256;
  return buf;
}
