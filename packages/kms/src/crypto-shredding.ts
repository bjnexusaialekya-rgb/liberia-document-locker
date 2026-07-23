/**
 * crypto-shredding.ts — RFP #11 / NIR Act 2011 + ECOWAS Supplementary Act
 * right-to-erasure requirement (master blueprint, "Data protection legal
 * basis"):
 *
 *   "a hash-chained, append-only audit log holding raw PII cannot satisfy
 *   a right-to-erasure request without breaking the chain. Resolution is
 *   cryptographic erasure: PII is encrypted with a per-citizen/per-document
 *   data key; on a valid erasure request, that specific key is destroyed,
 *   leaving the ledger hash-chain intact while the underlying data becomes
 *   permanently unrecoverable ciphertext."
 *
 * Because this package uses envelope encryption (see kms.ts), "destroy the
 * data key" does NOT mean deleting a named key from Vault — it means
 * permanently deleting the *wrapped* data key blob from
 * `encryption_key_mapping` (owned by Session 6). Once that blob is gone,
 * the tier key in Vault cannot unwrap anything for that record, and the
 * AES-256-GCM ciphertext already written to `document_versions` (or
 * wherever the encrypted payload lives) is permanently unrecoverable —
 * while every *other* citizen's data, which has its own wrapped data key,
 * is completely unaffected. This is what makes immutable audit logging and
 * legal erasure compatible.
 *
 * This module is intentionally storage-agnostic: it depends only on
 * `EncryptionKeyMappingStore` (types.ts). Session 6 provides the real
 * Postgres-backed implementation; tests here use an in-memory one.
 */

import type { AuditLogWriter, EncryptionKeyMappingStore, WrappedDataKeyRecord } from "./types";
import { KeyAlreadyDestroyedError } from "./errors";
import type { KeyTier } from "./key-tiers";

export interface CrypticShredRequest {
  reference: string;
  /** Who is performing the erasure — for the audit-log entry, not a permission check (that belongs upstream). */
  actorId: string;
  actorType: "SERVICE" | string;
  agencyId: string | null;
  /** e.g. "citizen right-to-erasure request #4821", surfaced in the audit metadata. */
  reason: string;
}

export class CryptoShredder {
  constructor(
    private readonly store: EncryptionKeyMappingStore,
    private readonly auditLog?: AuditLogWriter,
  ) {}

  /** Registers a newly generated wrapped data key against a reference. Called right after kms.encrypt(). */
  async registerKey(
    reference: string,
    tier: KeyTier,
    wrappedDataKey: string,
    keyVersion: number,
  ): Promise<void> {
    const record: WrappedDataKeyRecord = {
      reference,
      tier,
      wrappedDataKey,
      keyVersion,
      createdAt: new Date().toISOString(),
      destroyedAt: null,
    };
    await this.store.put(record);
  }

  /**
   * Executes cryptographic erasure for a single reference. Idempotent:
   * calling this twice on an already-destroyed reference throws
   * KeyAlreadyDestroyedError rather than silently succeeding, so callers
   * can distinguish "already erased" from "erased just now" for their own
   * response to the citizen.
   */
  async destroy(request: CrypticShredRequest): Promise<{ destroyedAt: string }> {
    const record = await this.store.get(request.reference);
    if (!record || record.destroyedAt !== null) {
      throw new KeyAlreadyDestroyedError(request.reference);
    }

    const destroyedAt = new Date().toISOString();
    await this.store.markDestroyed(request.reference, destroyedAt);

    if (this.auditLog) {
      await this.auditLog.write({
        eventType: "kms.key_destroyed_erasure_request",
        actorId: request.actorId,
        actorType: request.actorType,
        agencyId: request.agencyId,
        resourceType: "encryption_key_mapping",
        resourceId: request.reference,
        metadata: {
          tier: record.tier,
          reason: request.reason,
          // Never log wrappedDataKey or any PII here — metadata is not itself erasable.
        },
      });
    }

    return { destroyedAt };
  }

  /** True if the reference exists and has NOT been destroyed — i.e. still decryptable. */
  async isLive(reference: string): Promise<boolean> {
    const record = await this.store.get(reference);
    return record !== null && record.destroyedAt === null;
  }
}

/**
 * In-memory `EncryptionKeyMappingStore` for tests and local dev only.
 * Session 6 must supply the real Postgres-backed implementation — this is
 * explicitly NOT that, and must never be wired into a running service.
 */
export class InMemoryEncryptionKeyMappingStore implements EncryptionKeyMappingStore {
  private readonly rows = new Map<string, WrappedDataKeyRecord>();

  async get(reference: string): Promise<WrappedDataKeyRecord | null> {
    return this.rows.get(reference) ?? null;
  }

  async put(record: WrappedDataKeyRecord): Promise<void> {
    this.rows.set(record.reference, { ...record });
  }

  async markDestroyed(reference: string, destroyedAt: string): Promise<void> {
    const existing = this.rows.get(reference);
    if (!existing) return;
    // Physically overwrite the wrapped key material, don't just flag it —
    // mirrors what a real DELETE/UPDATE-to-null must do in Postgres.
    this.rows.set(reference, { ...existing, wrappedDataKey: "", destroyedAt });
  }
}
