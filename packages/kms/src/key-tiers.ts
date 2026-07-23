/**
 * Sensitivity tiers — RFP #11 / master blueprint §11 ("Admin and policy
 * control"): "One key per sensitivity tier (pii-standard, pii-biometric,
 * payment-data) so rotating one doesn't force rotating all."
 *
 * These map 1:1 to named Transit keys in Vault. They are the *wrapping*
 * keys used for envelope encryption (see kms.ts `generateDataKey`) — they
 * are never used to encrypt bulk data directly, and the platform never
 * creates one Vault key per citizen/document (that would not scale and is
 * not how Transit is meant to be used). Per-citizen/per-document isolation
 * for crypto-shredding is achieved one layer up, via generated data keys —
 * see crypto-shredding.ts for why that split matters.
 */
import { UnknownKeyTierError } from "./errors";

export const KEY_TIERS = ["pii-standard", "pii-biometric", "payment-data"] as const;
export type KeyTier = (typeof KEY_TIERS)[number];

export function isKeyTier(value: string): value is KeyTier {
  return (KEY_TIERS as readonly string[]).includes(value);
}

export function assertKeyTier(value: string): KeyTier {
  if (!isKeyTier(value)) throw new UnknownKeyTierError(value);
  return value;
}

/**
 * Transit key name for a given tier. Kept as an explicit function (rather
 * than assuming name === tier) so a future rename of the Vault-side key
 * doesn't require touching every call site.
 */
export function transitKeyNameForTier(tier: KeyTier): string {
  return tier;
}

/** Human-readable description surfaced in admin-api's key-rotation UI. */
export const KEY_TIER_DESCRIPTIONS: Record<KeyTier, string> = {
  "pii-standard": "General personally identifiable information (names, addresses, ID numbers).",
  "pii-biometric": "Biometric data (photos used for facial matching, fingerprint templates).",
  "payment-data": "Payment references and reconciliation data flowing through payment-engine.",
};
