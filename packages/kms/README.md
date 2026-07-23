# @liberia-locker/kms

**Session 2 / Phase 0.** RFP #11 — wraps HashiCorp Vault's Transit secrets
engine. App code only ever calls `kms.encrypt(payload, tier)` /
`kms.decrypt(...)`; it never sees a raw key, and never talks to Vault
directly.

Depends on: `@liberia-locker/shared-types` (Session 1).

Source of truth for everything in this package:
`master-blueprint-all-phases-liberia-document-locker.md`, "Admin and policy
control" (RFP #11) and "Data protection legal basis" sections.

## What's in here

| Module | Contents |
|---|---|
| `key-tiers.ts` | The 3 sensitivity tiers (`pii-standard`, `pii-biometric`, `payment-data`) and their Vault Transit key names. |
| `vault-client.ts` | `IVaultClient` interface + `HttpVaultClient`, a real HTTP client against Vault's Transit and `sys/*` APIs. No crypto is reimplemented here — this only speaks Vault's own wire protocol. |
| `kms.ts` | `VaultKms` — the public surface. Envelope encryption: generates a fresh 256-bit data key per record via Vault, encrypts locally with AES-256-GCM, discards the plaintext key. Also key rotation and re-wrap. |
| `crypto-shredding.ts` | `CryptoShredder` — right-to-erasure orchestration. Destroys a single record's wrapped data key, making its ciphertext permanently unrecoverable while every other record and the audit-log hash-chain stay untouched. Storage-agnostic via `EncryptionKeyMappingStore`. |
| `shamir.ts` | Standalone, real Shamir's Secret Sharing over GF(256) (generator 3, same field construction Vault itself uses). Independently testable — see "A note on the two Shamir implementations" below. |
| `vault-unseal-handover.ts` | The production key-custody handover: drives Vault's real `sys/init` (actual Shamir-sharing of the root/unseal material), tracks per-share custody records, and provably destroys BJNEXUS's local copies after redistribution. Not invoked anywhere automatically — this runs once, deliberately, at production launch. |
| `types.ts` | `WrappedDataKeyRecord`, `EncryptedPayload`, `EncryptionKeyMappingStore`, `AuditLogWriter` — the storage/audit seams this package depends on without taking a hard dependency on Postgres or `packages/audit-log`. |
| `errors.ts` | Typed error hierarchy (`VaultSealedError`, `KeyNotFoundError`, `KeyAlreadyDestroyedError`, etc.) so callers can branch on failure mode instead of string-matching. |

## Standing up Vault (do this first — it is not assumed to already exist)

Per the master blueprint: *"standing up Vault itself... is now explicitly
the first step of the `packages/kms` build session — it is not something
later sessions can assume is already running."*

```bash
cd packages/kms
cp .env.example .env       # edit VAULT_DEV_ROOT_TOKEN_ID to a real secret first
npm install
npm run vault:up           # docker-compose.vault.yml — dev-mode Vault on :8200
npm run vault:bootstrap    # enables Transit, creates the 3 tier keys (idempotent)
```

`VaultKms.bootstrap()` (in `kms.ts`) does the same enable-engine +
create-tier-keys work over the HTTP API directly — call it once at service
startup in real services; `scripts/bootstrap-vault.sh` is the documented
manual equivalent for local setup without writing Node first.

**This is dev mode.** Dev-mode Vault starts already unsealed with a single
well-known root token and stores everything in memory (lost on restart).
That is acceptable for build/demo phase per the blueprint, and is
explicitly *not* how production Vault will be initialized — see "Production
key custody" below.

## Installing / linking

Private workspace package, not published to npm.

```jsonc
// e.g. services/document-issuance/package.json
{
  "dependencies": {
    "@liberia-locker/kms": "workspace:*"
  }
}
```

If workspaces aren't wired up yet, `file:../../packages/kms` works
identically during early sessions (same note as Session 1's README).

Build before consuming — this package ships compiled `dist/`, not raw `src/`:

```bash
cd packages/kms
npm install
npm run build
```

## Usage

```ts
import { HttpVaultClient, VaultKms } from "@liberia-locker/kms";

const vault = new HttpVaultClient({
  addr: process.env.VAULT_ADDR!,
  token: process.env.VAULT_TOKEN!,
});
const kms = new VaultKms(vault);
await kms.bootstrap(); // idempotent — safe to call at every service startup

// Encrypting a citizen's PII field:
const { payload, wrapped } = await kms.encrypt("pii-standard", nationalIdNumber);
// Persist `payload` (ciphertext/iv/authTag) with the record itself, and
// `wrapped.wrappedDataKey` in encryption_key_mapping (Session 6), keyed by
// a reference such as `${citizenId}:${documentId}`.

// Decrypting:
const plaintext = await kms.decrypt("pii-standard", wrapped.wrappedDataKey, payload);
```

### Crypto-shredding (right-to-erasure)

```ts
import { CryptoShredder } from "@liberia-locker/kms";

// `store` is Session 6's real Postgres-backed EncryptionKeyMappingStore
// implementation (see types.ts) — the in-memory one shipped here is test-only.
const shredder = new CryptoShredder(store, auditLogClient);

await shredder.registerKey(reference, "pii-standard", wrapped.wrappedDataKey, keyVersion);

// On a valid right-to-erasure request:
await shredder.destroy({
  reference,
  actorId: currentActorId,
  actorType: "SERVICE",
  agencyId: null,
  reason: "citizen right-to-erasure request #4821",
});
// From this point, decrypt() for this reference will fail — the audit-log
// entry recording that this happened remains intact and unaltered.
```

### Key rotation (what `admin-api`'s `POST /admin/keys/:keyName/rotate` calls)

```ts
await kms.rotateTierKey("pii-standard");
// Existing wrapped data keys still decrypt (old key versions remain valid).
// Opportunistically re-wrap a specific record onto the new version:
const rewrapped = await kms.rewrapDataKey("pii-standard", oldWrappedDataKey);
```

## Why envelope encryption, not one Vault key per citizen

Transit is not designed to hold millions of named keys, and there is no way
to selectively "forget" one citizen's data if everyone shares 3 keys total.
Instead: each record gets its own 256-bit data key, generated on demand via
Vault's `transit/datakey/plaintext/{tierKey}` endpoint, used once locally
for AES-256-GCM, then discarded. Only the *wrapped* (Vault-encrypted) copy
of that data key is persisted — in `encryption_key_mapping`, owned by
Session 6, not by this package. Crypto-shredding a specific citizen's
record is therefore just deleting one small blob, not a Vault operation at
all — which is also why it can't accidentally take anyone else's data with
it. See `crypto-shredding.ts`'s module docstring for the full reasoning.

## A note on the two Shamir implementations

There are two separate things in this package that both involve Shamir's
Secret Sharing, and it's worth being explicit about why:

1. **`vault-unseal-handover.ts`** drives Vault's own real `sys/init` API.
   Vault performs genuine SSS internally when initialized with
   `secret_shares`/`secret_threshold` — this *is* the actual production
   mechanism protecting the root/unseal key. This module doesn't reimplement
   that math; it orchestrates the real thing plus the operational pieces
   the blueprint asks for (custody bookkeeping, provable destruction of
   BJNEXUS's local copies).
2. **`shamir.ts`** is a standalone, from-scratch SSS implementation
   (GF(256), generator 3, Lagrange interpolation) with no I/O and no
   dependency on a running Vault. It exists because the Session 2 prompt
   asks for "split key -> redistribute shares -> provably destroy" to be
   *"a documented, testable function"* in its own right — this is that,
   fully covered by `test/shamir.test.ts` independent of any live process.

Bug caught and fixed during this session: the first version of `shamir.ts`
built its GF(256) log/exp tables using generator `2`, which is **not**
actually a primitive element under the AES reducing polynomial (`0x11b`) —
it only generates a 51-element subgroup instead of spanning all 255
nonzero field elements, so most share-subset reconstructions silently
returned the wrong secret. Switched to generator `3` (the standard
Rijndael choice) and added a test (`"reconstructs correctly regardless of
which threshold-sized subset is used"`) specifically to catch a regression
of this class, not just a single hardcoded roundtrip.

## Production key custody — what's real vs. what's deferred

Per the blueprint: BJNEXUS holds Vault root/unseal authority during
build/demo phase (client-confirmed). At production launch, the plan is:

1. Initialize a **fresh, non-dev** Vault cluster via
   `initializeWithShamirSharing(vault, { totalShares: 5, threshold: 3, custodians })`
   — refuses to run against an already-initialized Vault, so this can't be
   accidentally re-run against a live system.
2. Real-world redistribution of the 5 shares to named government officials
   happens **out of band** (in person, sealed envelope, hardware token) —
   this is a process decision for the client, not something this package
   transmits. `buildCustodyRecords(...)` only produces the bookkeeping
   ledger of who received which share index and when.
3. `destroyBjnexusLocalShares(...)` securely erases BJNEXUS's temporary
   local copies: multi-pass random overwrite before unlink, plus a signed
   audit-log entry naming exactly which share indices were destroyed. This
   is called out honestly as *best-effort* on the raw-bytes-recovery front
   (traditional storage only — SSD wear-leveling and filesystem snapshots
   can retain data despite overwrite); the audit-log entry is the actual
   durable proof for an external auditor, not the overwrite itself.

**Explicitly open / blocked, not fabricated:**
- **Real HSM for production key custody remains blocked on the client.**
  This package builds against self-hosted Vault only and does not claim
  HSM-backed custody anywhere.
- **`shared-types`'s `AuditLogEventSchema` (`AUDIT_EVENT_TYPES`, Session 1)
  has no dedicated event type for the unseal-share-destruction step.**
  `destroyBjnexusLocalShares` currently reuses `kms.key_destroyed_erasure_request`
  with a clarifying `metadata.note` field distinguishing it from an actual
  citizen erasure request, rather than silently inventing a new enum value
  in a package that doesn't own `shared-types`. A follow-up to Session 1
  (adding e.g. `kms.unseal_shares_redistributed` / `kms.unseal_shares_destroyed`)
  is recommended before this handover is actually run at launch.
- **No concrete `EncryptionKeyMappingStore` implementation ships here.**
  The real Postgres-backed one is Session 6's responsibility
  (`documents`/`document_versions`/`credentials` schema). This package
  only defines the interface and ships an in-memory implementation
  explicitly marked test-only.

## Testing

```bash
npm test              # unit tests only (default) — fast, no Vault required
npm run test:integration   # requires a running Vault (npm run vault:up first)
npm run test:all      # both
```

- **Unit tests** (`test/kms.test.ts`, `test/crypto-shredding.test.ts`,
  `test/shamir.test.ts`) cover envelope-encryption round-trips, tier-key
  rotation/rewrap, crypto-shredding isolation (destroying one citizen's key
  never affects another's), and the Shamir algorithm's actual
  information-theoretic threshold property — not just a guard clause,
  see `"fewer-than-threshold shares reconstruct to garbage, not the real
  secret"`. These use `test/fakes/fake-vault-client.ts`, a test double that
  performs real AES-256-GCM wrapping in memory (not a pass-through stub) so
  the tests exercise genuine crypto behavior; it is **not** a substitute
  for real Vault integration.
- **Integration tests** (`test/vault-client.integration.test.ts`) make
  actual HTTP calls to a real running Vault's real Transit engine. This is
  what satisfies "real Vault Transit integration (not mocked crypto)" as a
  build requirement — the fake above proves the orchestration logic is
  correct, this proves the wire integration is correct. If Vault isn't
  reachable at `$VAULT_ADDR`, each test in this file guards itself at
  runtime and no-ops with a console notice rather than failing the suite
  (vitest evaluates `describe.runIf`/`it.skipIf` before an async `beforeAll`
  resolves, so a runtime guard was the only reliable option — noted in the
  file itself).

Both `npm run typecheck` and `npm run build` were run against this package
during this session and pass clean (strict mode, same `tsconfig.json`
conventions as Session 1).

## .env.example

See `.env.example` for `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_DEV_ROOT_TOKEN_ID`,
`VAULT_TRANSIT_MOUNT`. No real credentials are committed; the dev-mode root
token is a placeholder you must change in your own `.env`.
