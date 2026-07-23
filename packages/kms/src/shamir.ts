/**
 * shamir.ts — real Shamir's Secret Sharing (SSS), byte-wise over GF(256),
 * same field construction Vault itself uses for its own unseal key
 * sharding. This is a standalone, fully testable implementation: it does
 * not require a running Vault and has no I/O.
 *
 * Why this module exists separately from `vault-unseal-handover.ts`:
 * Vault already performs real SSS internally when you `PUT sys/init` with
 * `secret_shares`/`secret_threshold` — that's the actual production
 * mechanism protecting the root key, and vault-unseal-handover.ts drives
 * that real API. This module exists because the Session 2 prompt asks for
 * the split -> redistribute -> destroy pattern to be "a documented,
 * testable function" in its own right — useful for (a) unit-testing the
 * algorithm's correctness independent of a live Vault process, and (b) any
 * future need to shard a secret this package generates directly (e.g. a
 * break-glass recovery credential) using the identical, audited scheme.
 *
 * Algorithm: for a threshold-of-t reconstruction over n shares, pick a
 * random polynomial of degree (t-1) with the secret byte as the constant
 * term, evaluate it at n distinct nonzero x-coordinates, arithmetic done
 * in GF(2^8) with the AES reducing polynomial (0x11b) — reconstruction is
 * Lagrange interpolation at x=0 back in the same field. Each byte of a
 * multi-byte secret is shared independently with the same x-coordinates.
 */

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { InsufficientSharesError, ShamirParameterError } from "./errors";

export interface ShamirShare {
  /** 1..255 — the x-coordinate. Distinct per share, never 0 (0 would leak the secret directly). */
  x: number;
  /** Same length as the original secret — the y-coordinates, one byte of share per secret byte. */
  y: Buffer;
}

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
initTables();

/** a * 2 in GF(2^8) under the AES reducing polynomial x^8 + x^4 + x^3 + x + 1 (0x11b). */
function xtime(a: number): number {
  const shifted = a << 1;
  return (shifted & 0x100 ? shifted ^ 0x11b : shifted) & 0xff;
}

function initTables(): void {
  // Generator must be a primitive element of GF(2^8). 2 is NOT primitive
  // under 0x11b (it only generates a 51-element subgroup); 3 is the
  // standard primitive generator used by Rijndael's own log/exp tables.
  let a = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = a;
    GF_LOG[a] = i;
    a = xtime(a) ^ a; // a * 3
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] as number;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] as number) + (GF_LOG[b] as number)] as number;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new ShamirParameterError("division by zero in GF(256)");
  if (a === 0) return 0;
  return GF_EXP[((GF_LOG[a] as number) - (GF_LOG[b] as number) + 255) % 255] as number;
}

/** Evaluate the polynomial with given coefficients (coefficients[0] = constant term) at x, in GF(256). */
function gfPolyEval(coefficients: Uint8Array, x: number): number {
  let result = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) {
    result = gfMul(result, x) ^ (coefficients[i] as number);
  }
  return result;
}

export interface SplitOptions {
  shares: number;
  threshold: number;
}

/**
 * Splits `secret` into `options.shares` shares such that any
 * `options.threshold` of them reconstruct it, and fewer than that reveal
 * nothing (information-theoretic, not just computationally hard).
 */
export function splitSecret(secret: Buffer, options: SplitOptions): ShamirShare[] {
  const { shares, threshold } = options;
  if (!Number.isInteger(shares) || !Number.isInteger(threshold)) {
    throw new ShamirParameterError("shares and threshold must be integers");
  }
  if (threshold < 2) throw new ShamirParameterError("threshold must be >= 2");
  if (shares < threshold) throw new ShamirParameterError("shares must be >= threshold");
  if (shares > 255) throw new ShamirParameterError("shares must be <= 255 (GF(256) x-coordinate space)");
  if (secret.length === 0) throw new ShamirParameterError("secret must be non-empty");

  // Distinct, non-zero x-coordinates, one per share.
  const xs = pickDistinctNonZeroXs(shares);

  const shareBuffers = xs.map(() => Buffer.alloc(secret.length));

  for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
    // Random coefficients for degree (threshold-1); coefficients[0] is the secret byte itself.
    const coefficients = new Uint8Array(threshold);
    coefficients[0] = secret[byteIdx] as number;
    for (let c = 1; c < threshold; c++) {
      coefficients[c] = randomInt(1, 256); // nonzero, avoids a degenerate (lower-degree) polynomial
    }
    for (let s = 0; s < shares; s++) {
      (shareBuffers[s] as Buffer)[byteIdx] = gfPolyEval(coefficients, xs[s] as number);
    }
  }

  return xs.map((x, i) => ({ x, y: shareBuffers[i] as Buffer }));
}

/**
 * Reconstructs the original secret from `threshold`-or-more shares via
 * Lagrange interpolation at x=0. Throws InsufficientSharesError if fewer
 * than `expectedThreshold` shares are supplied (when provided) — pass the
 * threshold you split with; this module does not persist it.
 */
export function reconstructSecret(shares: ShamirShare[], expectedThreshold?: number): Buffer {
  if (shares.length === 0) throw new ShamirParameterError("no shares provided");
  if (expectedThreshold !== undefined && shares.length < expectedThreshold) {
    throw new InsufficientSharesError(shares.length, expectedThreshold);
  }
  const xsSeen = new Set<number>();
  for (const s of shares) {
    if (s.x === 0) throw new ShamirParameterError("share with x=0 is invalid");
    if (xsSeen.has(s.x)) throw new ShamirParameterError(`duplicate share x-coordinate: ${s.x}`);
    xsSeen.add(s.x);
  }
  const length = (shares[0] as ShamirShare).y.length;
  for (const s of shares) {
    if (s.y.length !== length) throw new ShamirParameterError("all shares must be the same length");
  }

  const secret = Buffer.alloc(length);
  for (let byteIdx = 0; byteIdx < length; byteIdx++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      const xi = (shares[i] as ShamirShare).x;
      const yi = (shares[i] as ShamirShare).y[byteIdx] as number;
      // Lagrange basis polynomial evaluated at x=0.
      let numerator = 1;
      let denominator = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        const xj = (shares[j] as ShamirShare).x;
        numerator = gfMul(numerator, xj);
        denominator = gfMul(denominator, xi ^ xj);
      }
      acc ^= gfMul(yi, gfDiv(numerator, denominator));
    }
    secret[byteIdx] = acc;
  }
  return secret;
}

/** Convenience: split+reconstruct self-check, useful right after generating shares before distributing them. */
export function verifySplit(secret: Buffer, allShares: ShamirShare[], threshold: number): boolean {
  const subset = allShares.slice(0, threshold);
  const reconstructed = reconstructSecret(subset, threshold);
  if (reconstructed.length !== secret.length) return false;
  return timingSafeEqual(reconstructed, secret);
}

function pickDistinctNonZeroXs(count: number): number[] {
  const pool = Array.from({ length: 255 }, (_, i) => i + 1); // 1..255
  // Fisher-Yates using crypto-secure randomness, then take the first `count`.
  const bytes = randomBytes(pool.length);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (bytes[i] as number) % (i + 1);
    const tmp = pool[i] as number;
    pool[i] = pool[j] as number;
    pool[j] = tmp;
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}
