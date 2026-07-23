import { describe, it, expect, beforeEach } from "vitest";
import { VaultKms, encryptPayload, decryptPayload } from "../src/kms";
import { KeyNotFoundError, VaultSealedError } from "../src/errors";
import { FakeVaultClient } from "./fakes/fake-vault-client";
import { KEY_TIERS } from "../src/key-tiers";

describe("VaultKms.bootstrap", () => {
  it("creates all 3 tier keys and is idempotent", async () => {
    const vault = new FakeVaultClient();
    const kms = new VaultKms(vault);

    await kms.bootstrap();
    for (const tier of KEY_TIERS) {
      expect(await vault.keyExists(tier)).toBe(true);
    }

    // second call should not throw / should not error on already-existing keys
    await expect(kms.bootstrap()).resolves.not.toThrow();
  });
});

describe("VaultKms.encrypt / decrypt (envelope encryption)", () => {
  let vault: FakeVaultClient;
  let kms: VaultKms;

  beforeEach(async () => {
    vault = new FakeVaultClient();
    kms = new VaultKms(vault);
    await kms.bootstrap();
  });

  it("round-trips a string payload", async () => {
    const { payload, wrapped } = await kms.encrypt("pii-standard", "Karuna Alekya K.");
    expect(wrapped.wrappedDataKey).toMatch(/^vault:v1:/);
    const decrypted = await kms.decrypt("pii-standard", wrapped.wrappedDataKey, payload);
    expect(decrypted.toString("utf8")).toBe("Karuna Alekya K.");
  });

  it("round-trips a binary payload", async () => {
    const original = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]);
    const { payload, wrapped } = await kms.encrypt("pii-biometric", original);
    const decrypted = await kms.decrypt("pii-biometric", wrapped.wrappedDataKey, payload);
    expect(decrypted.equals(original)).toBe(true);
  });

  it("uses a distinct data key per call — two encryptions of the same plaintext produce different ciphertext", async () => {
    const a = await kms.encrypt("payment-data", "same-plaintext");
    const b = await kms.encrypt("payment-data", "same-plaintext");
    expect(a.payload.ciphertext).not.toBe(b.payload.ciphertext);
    expect(a.wrapped.wrappedDataKey).not.toBe(b.wrapped.wrappedDataKey);
  });

  it("throws KeyNotFoundError when the tier key was deleted out from under it", async () => {
    await vault.allowKeyDeletion("pii-standard");
    await vault.deleteKey("pii-standard");
    await expect(kms.generateDataKey("pii-standard")).rejects.toThrow(KeyNotFoundError);
  });

  it("throws VaultSealedError when Vault is sealed", async () => {
    vault.setSealed(true);
    await expect(kms.generateDataKey("pii-standard")).rejects.toThrow(VaultSealedError);
  });

  it("decrypt fails (auth tag mismatch) if ciphertext is tampered with", async () => {
    const { payload, wrapped } = await kms.encrypt("pii-standard", "tamper test");
    const tampered = { ...payload, ciphertext: flipLastByte(payload.ciphertext) };
    await expect(kms.decrypt("pii-standard", wrapped.wrappedDataKey, tampered)).rejects.toThrow();
  });
});

describe("VaultKms.rotateTierKey / rewrapDataKey", () => {
  it("data encrypted before rotation still decrypts after rotation (old versions remain valid)", async () => {
    const vault = new FakeVaultClient();
    const kms = new VaultKms(vault);
    await kms.bootstrap();

    const { payload, wrapped } = await kms.encrypt("pii-standard", "pre-rotation secret");
    await kms.rotateTierKey("pii-standard");

    const decrypted = await kms.decrypt("pii-standard", wrapped.wrappedDataKey, payload);
    expect(decrypted.toString("utf8")).toBe("pre-rotation secret");
  });

  it("rewrapDataKey moves a data key onto the latest tier-key version", async () => {
    const vault = new FakeVaultClient();
    const kms = new VaultKms(vault);
    await kms.bootstrap();

    const { payload, wrapped } = await kms.encrypt("pii-standard", "rewrap me");
    await kms.rotateTierKey("pii-standard");
    const rewrapped = await kms.rewrapDataKey("pii-standard", wrapped.wrappedDataKey);

    expect(rewrapped.wrappedDataKey).toMatch(/^vault:v2:/);
    const decrypted = await kms.decrypt("pii-standard", rewrapped.wrappedDataKey, payload);
    expect(decrypted.toString("utf8")).toBe("rewrap me");
  });
});

describe("encryptPayload / decryptPayload (local AES-256-GCM primitives)", () => {
  it("rejects a data key that isn't exactly 32 bytes", () => {
    const shortKey = Buffer.alloc(16);
    expect(() => encryptPayload(shortKey, "x")).toThrow(RangeError);
  });

  it("round-trips directly given a raw 32-byte key", () => {
    const key = Buffer.alloc(32, 7);
    const payload = encryptPayload(key, "direct primitive test");
    const decrypted = decryptPayload(key, payload);
    expect(decrypted.toString("utf8")).toBe("direct primitive test");
  });

  it("fails to decrypt with the wrong key", () => {
    const key1 = Buffer.alloc(32, 1);
    const key2 = Buffer.alloc(32, 2);
    const payload = encryptPayload(key1, "wrong key test");
    expect(() => decryptPayload(key2, payload)).toThrow();
  });
});

function flipLastByte(base64: string): string {
  const buf = Buffer.from(base64, "base64");
  buf[buf.length - 1] = (buf[buf.length - 1] as number) ^ 0xff;
  return buf.toString("base64");
}
