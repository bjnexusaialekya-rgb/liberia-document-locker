/**
 * Typed error hierarchy for packages/kms.
 *
 * Every failure mode that a caller might need to branch on (vault down vs.
 * key missing vs. key already crypto-shredded) gets its own class instead of
 * string-matching error messages — this matters because admin-api and every
 * service that calls kms.decrypt() needs to distinguish "transient, retry"
 * from "permanently gone, this is expected after an erasure request" from
 * "bug, page someone".
 */

export class KmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Vault is unreachable (network/DNS/timeout) — distinct from Vault reachable-but-erroring. */
export class VaultUnreachableError extends KmsError {
  constructor(addr: string, cause: unknown) {
    super(`Vault at ${addr} is unreachable: ${String(cause)}`);
  }
}

/** Vault responded, but with a non-2xx status. Carries the raw body for logging/debugging. */
export class VaultApiError extends KmsError {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Vault API error ${status} on ${path}: ${JSON.stringify(body)}`);
  }
}

/** Vault is sealed and cannot service crypto operations until unsealed. */
export class VaultSealedError extends KmsError {
  constructor() {
    super("Vault is sealed. Crypto operations cannot proceed until it is unsealed.");
  }
}

/** The requested named key does not exist in the Transit engine (and this call did not create it). */
export class KeyNotFoundError extends KmsError {
  constructor(keyName: string) {
    super(`Key "${keyName}" does not exist in the transit engine.`);
  }
}

/**
 * Raised by decrypt operations against a data key reference whose wrapped
 * material has already been destroyed by a prior crypto-shredding /
 * right-to-erasure request. This is an EXPECTED outcome, not a bug — callers
 * (e.g. documents/document_versions readers) should catch this specifically
 * and render "this record was erased on <date>" rather than a generic 500.
 */
export class KeyAlreadyDestroyedError extends KmsError {
  constructor(public readonly reference: string) {
    super(
      `Data key for reference "${reference}" has been destroyed (crypto-shredded) and is not recoverable.`,
    );
  }
}

/** An unsupported/unknown sensitivity tier was requested. */
export class UnknownKeyTierError extends KmsError {
  constructor(tier: string) {
    super(`Unknown key tier "${tier}". Expected one of the KEY_TIERS values.`);
  }
}

/** Shamir split/reconstruct was called with parameters that cannot produce a valid scheme. */
export class ShamirParameterError extends KmsError {}

/** Reconstruction was attempted with too few shares to meet the configured threshold. */
export class InsufficientSharesError extends KmsError {
  constructor(provided: number, threshold: number) {
    super(`${provided} share(s) provided but threshold requires at least ${threshold}.`);
  }
}
