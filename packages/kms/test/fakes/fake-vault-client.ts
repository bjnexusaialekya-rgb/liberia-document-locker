/**
 * Test double for IVaultClient — used ONLY by unit tests for orchestration
 * logic (kms.ts, crypto-shredding.ts) that should not need a live Vault
 * process to verify. It does real AES-256-GCM wrapping internally (not a
 * pass-through stub) so the tests exercise genuine encrypt/decrypt
 * behavior end to end; it is NOT a substitute for the real Vault Transit
 * integration, which is exercised separately in
 * test/vault-client.integration.test.ts against an actual Vault (see
 * README "Testing" section for why both exist and what each proves).
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type {
  IVaultClient,
  TransitDataKeyResult,
  TransitDecryptResult,
  TransitEncryptResult,
  VaultInitResult,
  VaultKeyInfo,
  VaultSealStatus,
} from "../../src/vault-client";
import { KeyNotFoundError, VaultApiError, VaultSealedError } from "../../src/errors";

interface FakeKey {
  name: string;
  versions: Buffer[]; // index 0 = version 1
  deletionAllowed: boolean;
}

export class FakeVaultClient implements IVaultClient {
  private keys = new Map<string, FakeKey>();
  private sealed = false;
  private initialized = true;

  setSealed(sealed: boolean): void {
    this.sealed = sealed;
  }

  setInitialized(initialized: boolean): void {
    this.initialized = initialized;
  }

  private assertUnsealed(): void {
    if (this.sealed) throw new VaultSealedError();
  }

  private mustGetKey(name: string): FakeKey {
    const key = this.keys.get(name);
    if (!key) throw new VaultApiError(404, `transit/keys/${name}`, { errors: ["key not found"] });
    return key;
  }

  async health(): Promise<{ initialized: boolean; sealed: boolean }> {
    return { initialized: this.initialized, sealed: this.sealed };
  }

  async ensureTransitEngineEnabled(): Promise<void> {
    // no-op: this fake only ever models the transit engine
  }

  async keyExists(keyName: string): Promise<boolean> {
    return this.keys.has(keyName);
  }

  async createKey(keyName: string): Promise<void> {
    if (this.keys.has(keyName)) return;
    this.keys.set(keyName, { name: keyName, versions: [randomBytes(32)], deletionAllowed: false });
  }

  async getKeyInfo(keyName: string): Promise<VaultKeyInfo> {
    const key = this.mustGetKey(keyName);
    return {
      name: key.name,
      type: "aes256-gcm96",
      latestVersion: key.versions.length,
      minDecryptionVersion: 1,
      deletionAllowed: key.deletionAllowed,
    };
  }

  async rotateKey(keyName: string): Promise<{ latestVersion: number }> {
    this.assertUnsealed();
    const key = this.mustGetKey(keyName);
    key.versions.push(randomBytes(32));
    return { latestVersion: key.versions.length };
  }

  async rewrap(keyName: string, ciphertext: string): Promise<TransitEncryptResult> {
    this.assertUnsealed();
    const { plaintext } = await this.decrypt(keyName, ciphertext);
    return this.encrypt(keyName, plaintext);
  }

  async encrypt(keyName: string, plaintextBase64: string): Promise<TransitEncryptResult> {
    this.assertUnsealed();
    const key = this.mustGetKey(keyName);
    const version = key.versions.length;
    const kek = key.versions[version - 1] as Buffer;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintextBase64, "base64")), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Mimic Vault's "vault:vN:base64..." envelope shape closely enough for tests to assert on it.
    const packed = Buffer.concat([iv, tag, ct]).toString("base64");
    return { ciphertext: `vault:v${version}:${packed}` };
  }

  async decrypt(keyName: string, ciphertext: string): Promise<TransitDecryptResult> {
    this.assertUnsealed();
    const key = this.mustGetKey(keyName);
    const match = /^vault:v(\d+):(.+)$/.exec(ciphertext);
    if (!match) throw new VaultApiError(400, `transit/decrypt/${keyName}`, { errors: ["invalid ciphertext format"] });
    const version = Number(match[1]);
    const kek = key.versions[version - 1];
    if (!kek) throw new VaultApiError(400, `transit/decrypt/${keyName}`, { errors: ["unknown key version"] });
    const packed = Buffer.from(match[2] as string, "base64");
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ct = packed.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", kek, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    return { plaintext: plaintext.toString("base64") };
  }

  async generateDataKey(keyName: string): Promise<TransitDataKeyResult> {
    this.assertUnsealed();
    this.mustGetKey(keyName); // ensures 404 behavior matches real Vault when tier key is missing
    const dataKey = randomBytes(32);
    const wrapped = await this.encrypt(keyName, dataKey.toString("base64"));
    return { plaintext: dataKey.toString("base64"), ciphertext: wrapped.ciphertext };
  }

  async allowKeyDeletion(keyName: string): Promise<void> {
    const key = this.mustGetKey(keyName);
    key.deletionAllowed = true;
  }

  async deleteKey(keyName: string): Promise<void> {
    const key = this.mustGetKey(keyName);
    if (!key.deletionAllowed) {
      throw new VaultApiError(400, `transit/keys/${keyName}`, {
        errors: ["deletion is not allowed for this key"],
      });
    }
    this.keys.delete(keyName);
  }

  async initStatus(): Promise<{ initialized: boolean }> {
    return { initialized: this.initialized };
  }

  async init(secretShares: number, _secretThreshold: number): Promise<VaultInitResult> {
    this.initialized = true;
    this.sealed = false;
    return {
      rootToken: `fake-root-token-${randomBytes(4).toString("hex")}`,
      keyShares: Array.from({ length: secretShares }, () => randomBytes(32).toString("base64")),
    };
  }

  async sealStatus(): Promise<VaultSealStatus> {
    return { sealed: this.sealed, t: 3, n: 5, progress: 0 };
  }
}

export function assertKeyNotFound(err: unknown): asserts err is KeyNotFoundError {
  if (!(err instanceof KeyNotFoundError)) throw err;
}
