/**
 * kms.ts — the package's public surface: `kms.encrypt(payload, tier)` /
 * `kms.decrypt(...)`. App code calls this and only this; it never touches
 * IVaultClient, a raw key, or AES directly.
 *
 * Design: envelope encryption, not "one Vault key per record."
 *   1. For each record needing encryption, generate a fresh 256-bit data
 *      key via Vault's `transit/datakey/plaintext/{tierKey}` endpoint. Vault
 *      returns both the raw plaintext key (used once, in memory, then
 *      discarded) and that same key wrapped (encrypted) by the tier key.
 *   2. Encrypt the actual payload locally with AES-256-GCM using the
 *      plaintext data key. Discard the plaintext data key immediately.
 *   3. Persist the wrapped data key (via EncryptionKeyMappingStore, owned
 *      by the calling service) alongside the ciphertext payload.
 *   4. To decrypt: unwrap the data key via Vault (`transit/decrypt`), use
 *      it locally to AES-decrypt the payload, discard the plaintext key.
 *
 * Why not a named Vault key per citizen/document? Transit is not designed
 * to hold millions of named keys, and Vault has no way to "encrypt one
 * citizen's field but not another's" with only 3 keys. Envelope encryption
 * gives per-record key isolation (needed for crypto-shredding — see
 * crypto-shredding.ts) while Vault only ever manages the 3 tier keys.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { IVaultClient } from "./vault-client";
import { KeyNotFoundError, VaultApiError } from "./errors";
import { KEY_TIERS, type KeyTier, transitKeyNameForTier } from "./key-tiers";
import type { EncryptedPayload } from "./types";

const AES_ALGO = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

export interface GeneratedDataKey {
  /** Wrap this and persist it via EncryptionKeyMappingStore. Never store the plaintext. */
  wrappedDataKey: string;
  /** Tier key version active at generation time — informational, not required for decrypt. */
  keyVersion: number;
}

export class VaultKms {
  constructor(private readonly vault: IVaultClient) {}

  /**
   * Idempotent setup: creates the 3 tier keys in Vault's Transit engine if
   * they don't already exist, and ensures the Transit engine itself is
   * mounted. Call once at service startup (or via the bootstrap script for
   * local dev — see scripts/bootstrap-vault.sh).
   */
  async bootstrap(): Promise<void> {
    await this.vault.ensureTransitEngineEnabled();
    for (const tier of KEY_TIERS) {
      const keyName = transitKeyNameForTier(tier);
      const exists = await this.vault.keyExists(keyName);
      if (!exists) await this.vault.createKey(keyName);
    }
  }

  /** Generates a new per-record data key wrapped by the given tier's Vault key. See module docstring. */
  async generateDataKey(tier: KeyTier): Promise<{ plaintextKey: Buffer; wrapped: GeneratedDataKey }> {
    const keyName = transitKeyNameForTier(tier);
    const result = await this.wrapVaultKeyNotFound(keyName, () => this.vault.generateDataKey(keyName));
    const info = await this.vault.getKeyInfo(keyName);
    return {
      plaintextKey: Buffer.from(result.plaintext, "base64"),
      wrapped: { wrappedDataKey: result.ciphertext, keyVersion: info.latestVersion },
    };
  }

  /** Unwraps a previously generated data key. Throws KeyNotFoundError if the tier key was deleted. */
  async unwrapDataKey(tier: KeyTier, wrappedDataKey: string): Promise<Buffer> {
    const keyName = transitKeyNameForTier(tier);
    const result = await this.wrapVaultKeyNotFound(keyName, () =>
      this.vault.decrypt(keyName, wrappedDataKey),
    );
    return Buffer.from(result.plaintext, "base64");
  }

  /** Convenience: generate a data key, encrypt `plaintext` with it, return both the ciphertext and the wrapped key to persist. */
  async encrypt(
    tier: KeyTier,
    plaintext: Buffer | string,
  ): Promise<{ payload: EncryptedPayload; wrapped: GeneratedDataKey }> {
    const { plaintextKey, wrapped } = await this.generateDataKey(tier);
    try {
      const payload = encryptPayload(plaintextKey, plaintext);
      return { payload, wrapped };
    } finally {
      plaintextKey.fill(0); // best-effort zeroing; Buffer/GC in Node gives no hard guarantee, but this costs nothing.
    }
  }

  /** Convenience: unwrap the data key referenced by `wrappedDataKey` and decrypt `payload` with it. */
  async decrypt(tier: KeyTier, wrappedDataKey: string, payload: EncryptedPayload): Promise<Buffer> {
    const plaintextKey = await this.unwrapDataKey(tier, wrappedDataKey);
    try {
      return decryptPayload(plaintextKey, payload);
    } finally {
      plaintextKey.fill(0);
    }
  }

  /**
   * Rotates a tier key (`admin-api`'s `POST /admin/keys/:keyName/rotate`
   * calls this under the hood). Rotation creates a new key version; Vault
   * keeps prior versions around so existing wrapped data keys still
   * decrypt (min_decryption_version stays at 1 unless explicitly raised).
   * Callers wanting to re-wrap existing data keys under the new version
   * should use `rewrapDataKey` opportunistically, not as part of rotation
   * itself — rotation must not require touching every existing record
   * synchronously.
   */
  async rotateTierKey(tier: KeyTier): Promise<{ tier: KeyTier; latestVersion: number }> {
    const keyName = transitKeyNameForTier(tier);
    const { latestVersion } = await this.wrapVaultKeyNotFound(keyName, () => this.vault.rotateKey(keyName));
    return { tier, latestVersion };
  }

  /** Re-wraps a single data key under the tier key's current version, without exposing the plaintext data key. */
  async rewrapDataKey(tier: KeyTier, wrappedDataKey: string): Promise<GeneratedDataKey> {
    const keyName = transitKeyNameForTier(tier);
    const result = await this.wrapVaultKeyNotFound(keyName, () => this.vault.rewrap(keyName, wrappedDataKey));
    const info = await this.vault.getKeyInfo(keyName);
    return { wrappedDataKey: result.ciphertext, keyVersion: info.latestVersion };
  }

  private async wrapVaultKeyNotFound<T>(keyName: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VaultApiError && err.status === 404) throw new KeyNotFoundError(keyName);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Local AES-256-GCM helpers — operate only on already-unwrapped data keys.
// Exported for use by crypto-shredding.ts and for direct unit testing.
// ---------------------------------------------------------------------------

export function encryptPayload(dataKey: Buffer, plaintext: Buffer | string): EncryptedPayload {
  if (dataKey.length !== 32) throw new RangeError("data key must be 32 bytes (256 bits)");
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(AES_ALGO, dataKey, iv);
  const input = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptPayload(dataKey: Buffer, payload: EncryptedPayload): Buffer {
  if (dataKey.length !== 32) throw new RangeError("data key must be 32 bytes (256 bits)");
  const decipher = createDecipheriv(AES_ALGO, dataKey, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
}
