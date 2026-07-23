import { describe, it, expect } from "vitest";
import { VaultKms } from "../src/kms";
import { CryptoShredder, InMemoryEncryptionKeyMappingStore } from "../src/crypto-shredding";
import { KeyAlreadyDestroyedError } from "../src/errors";
import { FakeVaultClient } from "./fakes/fake-vault-client";
import type { AuditLogWriter } from "../src/types";

function fakeAuditLog(): AuditLogWriter & { entries: Parameters<AuditLogWriter["write"]>[0][] } {
  const entries: Parameters<AuditLogWriter["write"]>[0][] = [];
  return {
    entries,
    async write(entry) {
      entries.push(entry);
    },
  };
}

describe("CryptoShredder — the crypto-shredding right-to-erasure requirement", () => {
  it("data is decryptable before destroy and permanently unrecoverable after destroy", async () => {
    const vault = new FakeVaultClient();
    const kms = new VaultKms(vault);
    await kms.bootstrap();

    const store = new InMemoryEncryptionKeyMappingStore();
    const audit = fakeAuditLog();
    const shredder = new CryptoShredder(store, audit);

    const reference = "citizen:9001:document:national_id:1";
    const { payload, wrapped } = await kms.encrypt("pii-standard", "sensitive PII payload");
    await shredder.registerKey(reference, "pii-standard", wrapped.wrappedDataKey, 1);

    // Live before destroy: decrypt works, using the wrapped key looked up from the store.
    const before = await store.get(reference);
    expect(before?.destroyedAt).toBeNull();
    const decryptedBefore = await kms.decrypt("pii-standard", (before as NonNullable<typeof before>).wrappedDataKey, payload);
    expect(decryptedBefore.toString("utf8")).toBe("sensitive PII payload");
    expect(await shredder.isLive(reference)).toBe(true);

    // Destroy.
    const result = await shredder.destroy({
      reference,
      actorId: "admin-api:erasure-workflow",
      actorType: "SERVICE",
      agencyId: null,
      reason: "citizen right-to-erasure request #4821",
    });
    expect(result.destroyedAt).toBeTruthy();

    // After destroy: the wrapped key material is gone from the store — the ciphertext
    // payload itself (which lives in document_versions, outside this package's scope)
    // is now permanently unrecoverable because nothing can unwrap its data key anymore.
    const after = await store.get(reference);
    expect(after?.destroyedAt).toBe(result.destroyedAt);
    expect(after?.wrappedDataKey).toBe("");
    expect(await shredder.isLive(reference)).toBe(false);
  });

  it("is idempotent: destroying an already-destroyed reference throws KeyAlreadyDestroyedError, not a silent success", async () => {
    const store = new InMemoryEncryptionKeyMappingStore();
    const shredder = new CryptoShredder(store);
    await shredder.registerKey("ref-1", "pii-standard", "vault:v1:fake", 1);
    await shredder.destroy({ reference: "ref-1", actorId: "a", actorType: "SERVICE", agencyId: null, reason: "test" });

    await expect(
      shredder.destroy({ reference: "ref-1", actorId: "a", actorType: "SERVICE", agencyId: null, reason: "test again" }),
    ).rejects.toThrow(KeyAlreadyDestroyedError);
  });

  it("destroying one citizen's key does not affect another citizen's key (isolation)", async () => {
    const vault = new FakeVaultClient();
    const kms = new VaultKms(vault);
    await kms.bootstrap();
    const store = new InMemoryEncryptionKeyMappingStore();
    const shredder = new CryptoShredder(store);

    const alice = await kms.encrypt("pii-standard", "alice's PII");
    const bob = await kms.encrypt("pii-standard", "bob's PII");
    await shredder.registerKey("citizen:alice", "pii-standard", alice.wrapped.wrappedDataKey, 1);
    await shredder.registerKey("citizen:bob", "pii-standard", bob.wrapped.wrappedDataKey, 1);

    await shredder.destroy({ reference: "citizen:alice", actorId: "a", actorType: "SERVICE", agencyId: null, reason: "erasure" });

    expect(await shredder.isLive("citizen:alice")).toBe(false);
    expect(await shredder.isLive("citizen:bob")).toBe(true);

    // Bob's data is still fully decryptable.
    const bobRecord = await store.get("citizen:bob");
    const bobDecrypted = await kms.decrypt(
      "pii-standard",
      (bobRecord as NonNullable<typeof bobRecord>).wrappedDataKey,
      bob.payload,
    );
    expect(bobDecrypted.toString("utf8")).toBe("bob's PII");
  });

  it("writes a kms.key_destroyed_erasure_request audit entry without leaking the wrapped key material", async () => {
    const store = new InMemoryEncryptionKeyMappingStore();
    const audit = fakeAuditLog();
    const shredder = new CryptoShredder(store, audit);
    await shredder.registerKey("ref-audit", "pii-biometric", "vault:v1:some-wrapped-key", 1);

    await shredder.destroy({
      reference: "ref-audit",
      actorId: "admin-api:erasure-workflow",
      actorType: "SERVICE",
      agencyId: "00000000-0000-0000-0000-000000000001",
      reason: "citizen right-to-erasure request #77",
    });

    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0] as NonNullable<(typeof audit.entries)[number]>;
    expect(entry.eventType).toBe("kms.key_destroyed_erasure_request");
    expect(entry.resourceId).toBe("ref-audit");
    expect(JSON.stringify(entry.metadata)).not.toContain("some-wrapped-key");
  });

  it("throws KeyAlreadyDestroyedError (not a generic error) when destroying a reference that was never registered", async () => {
    const store = new InMemoryEncryptionKeyMappingStore();
    const shredder = new CryptoShredder(store);
    await expect(
      shredder.destroy({ reference: "never-existed", actorId: "a", actorType: "SERVICE", agencyId: null, reason: "x" }),
    ).rejects.toThrow(KeyAlreadyDestroyedError);
  });
});
