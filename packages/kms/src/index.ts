/**
 * @liberia-locker/kms
 *
 * Foundation package (Phase 0, Session 2). Wraps HashiCorp Vault's Transit
 * secrets engine so no other package or service ever handles a raw
 * encryption key. See README.md for setup, usage, and the key-custody /
 * crypto-shredding design this package implements.
 */

export { KEY_TIERS, KEY_TIER_DESCRIPTIONS, isKeyTier, assertKeyTier, transitKeyNameForTier } from "./key-tiers";
export type { KeyTier } from "./key-tiers";

export {
  KmsError,
  VaultUnreachableError,
  VaultApiError,
  VaultSealedError,
  KeyNotFoundError,
  KeyAlreadyDestroyedError,
  UnknownKeyTierError,
  ShamirParameterError,
  InsufficientSharesError,
} from "./errors";

export { HttpVaultClient } from "./vault-client";
export type {
  IVaultClient,
  VaultClientConfig,
  TransitEncryptResult,
  TransitDecryptResult,
  TransitDataKeyResult,
  VaultKeyInfo,
  VaultInitResult,
  VaultSealStatus,
} from "./vault-client";

export { VaultKms, encryptPayload, decryptPayload } from "./kms";
export type { GeneratedDataKey } from "./kms";

export { CryptoShredder, InMemoryEncryptionKeyMappingStore } from "./crypto-shredding";
export type { CrypticShredRequest } from "./crypto-shredding";

export type {
  WrappedDataKeyRecord,
  EncryptedPayload,
  EncryptionKeyMappingStore,
  AuditLogWriter,
} from "./types";

export { splitSecret, reconstructSecret, verifySplit } from "./shamir";
export type { ShamirShare, SplitOptions } from "./shamir";

export {
  initializeWithShamirSharing,
  buildCustodyRecords,
  destroyBjnexusLocalShares,
  VaultInitAlreadyDoneError,
} from "./vault-unseal-handover";
export type { HandoverPlan, ShareCustodyRecord, HandoverResult } from "./vault-unseal-handover";
