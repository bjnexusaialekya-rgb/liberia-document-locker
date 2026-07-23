import type { KeyTier } from "./key-tiers";

/**
 * A record of one generated data key, wrapped by a tier's Transit key.
 * This is the shape the `encryption_key_mapping` table (Session 6 —
 * documents/document_versions/credentials schema — see blueprint §
 * "Data protection legal basis") is expected to persist, keyed by
 * citizen/document reference. packages/kms does not own that table; it
 * owns the crypto operations performed against rows in it, via the
 * `EncryptionKeyMappingStore` interface below so this package stays
 * storage-agnostic and testable without a real database.
 */
export interface WrappedDataKeyRecord {
  /** Opaque identifier the owning service uses — e.g. `${citizenId}:${documentId}`. */
  reference: string;
  tier: KeyTier;
  /** The data key ciphertext as returned by Vault's transit/datakey endpoint. Never the plaintext. */
  wrappedDataKey: string;
  /** Transit key version active when this data key was generated — for audit/debugging, not required for decrypt. */
  keyVersion: number;
  createdAt: string; // ISO 8601
  /** Set only after a successful crypto-shredding destroy. Presence of this field means unrecoverable. */
  destroyedAt: string | null;
}

/** AES-256-GCM envelope produced by encryptPayload(). Store all four fields together. */
export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64, 12 bytes
  authTag: string; // base64, 16 bytes
}

/**
 * Storage seam for `encryption_key_mapping` rows. packages/kms depends only
 * on this interface — never on a concrete DB client — so crypto-shredding
 * logic is unit-testable and the owning service (Session 6) can implement
 * it against real Postgres without packages/kms taking a `pg` dependency.
 *
 * NOT YET WIRED: no concrete Postgres-backed implementation exists yet
 * because the `documents`/`document_versions` schema (Session 6) has not
 * been built. This is expected per the "Depends on" note in the Session 2
 * prompt and is not a gap in this package — flagged here and in the
 * README so it isn't silently assumed to already exist.
 */
export interface EncryptionKeyMappingStore {
  get(reference: string): Promise<WrappedDataKeyRecord | null>;
  put(record: WrappedDataKeyRecord): Promise<void>;
  /** Marks the row destroyed. Implementations MUST NOT physically retain the wrappedDataKey after this resolves. */
  markDestroyed(reference: string, destroyedAt: string): Promise<void>;
}

/** Minimal audit-log write shape this package depends on — see packages/audit-log (Session 5) for the real client. */
export interface AuditLogWriter {
  write(entry: {
    eventType: "kms.key_rotated" | "kms.key_destroyed_erasure_request";
    actorId: string;
    actorType: "SERVICE" | string;
    agencyId: string | null;
    resourceType: string;
    resourceId: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}
