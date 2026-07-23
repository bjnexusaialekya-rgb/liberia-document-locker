# @liberia-locker/shared-types

**Session 1 / Phase 0.** Foundation package — depends on nothing else in this
monorepo. Every other package (`kms`, `mtls`, `http-kit`, `audit-log`, `db`)
and all 14 services and 3 client apps import their shared types, enums, and
runtime validation schemas from here.

Source of truth for everything in this package:
`master-blueprint-all-phases-liberia-document-locker.md`.

## What's in here

| Module | Contents |
|---|---|
| `enums.ts` | Every shared string-literal union: `DocumentType` (10), `Phase1DocumentType` (6), `AgencyCode` (6), `UserType` (4), `Role`, `DocumentStatus`, `ConsentState`, `PaymentStatus`, etc. |
| `agencies.ts` | `Agency` type + `AGENCY_REGISTRY` static reference data for the 6 seeded agencies (NIR, MOT, LNP, LBR, LRA, LLA). |
| `document-types.ts` | `DocumentTypeDefinition` + the full 10-row `DOCUMENT_TYPE_REGISTRY`, including `requiresReview` and `isPhase1` as real queryable flags (not documentation), credential format per type, renewal eligibility, and physical-asset-custody tracking. |
| `users.ts` | `User`, `UserRoleGrant`, and the shared `violatesSeparationOfDuties()` predicate (issuer ≠ approver ≠ auditor, per the Phase 1 test gate). |
| `consent.ts` | `ConsentGrant` + the `pending_otp -> active -> (expired \| revoked)` state machine and its transition-validity helper. |
| `audit-log.ts` | `AuditLogEvent`, the hash-chain write-request contract, and the shared `AuditEventType` taxonomy every service's events must draw from. |
| `api/` | Cross-service request/response contracts: `documents.ts`, `consent.ts`, `verification.ts`, `payments.ts`, plus `common.ts` (shared error shape, pagination, the `Idempotency-Key` header contract). |

Every exported type has a matching `zod` schema of the same name +
`Schema` suffix (e.g. `ConsentGrant` / `ConsentGrantSchema`) so services can
validate untrusted input (HTTP bodies, queue messages) at the boundary and
get a fully-typed object back — not two parallel definitions to keep in sync
by hand.

## Installing / linking

This is a private workspace package, not published to npm. From another
package or service in the monorepo:

```jsonc
// e.g. services/document-issuance/package.json
{
  "dependencies": {
    "@liberia-locker/shared-types": "workspace:*"
  }
}
```

If the monorepo isn't wired up with npm workspaces yet, a `file:`
reference works identically during early sessions:

```json
{
  "dependencies": {
    "@liberia-locker/shared-types": "file:../../packages/shared-types"
  }
}
```

Build before consuming (this package ships compiled `dist/`, not raw `src/`):

```bash
cd packages/shared-types
npm install
npm run build     # emits dist/*.js + dist/*.d.ts
```

## Importing

```ts
import {
  DOCUMENT_TYPE_REGISTRY,
  PHASE_1_DOCUMENT_TYPES,
  isPhase1DocumentType,
  ConsentGrantSchema,
  type ConsentGrant,
  type IssueDocumentRequest,
  IssueDocumentRequestSchema,
} from "@liberia-locker/shared-types";

// Runtime validation at a service boundary:
const parsed = IssueDocumentRequestSchema.parse(req.body); // throws ZodError on bad input
// parsed is now typed as IssueDocumentRequest, not `any`

// Filtering the Phase 1 demo scope, per the 2026-07-19 addendum:
const phase1Types = Object.values(DOCUMENT_TYPE_REGISTRY).filter((d) => d.isPhase1);
```

Everything is re-exported from the package root (`src/index.ts` ->
`dist/index.js`) — services should import from `@liberia-locker/shared-types`
directly, not reach into `dist/document-types.js` etc.

## Design decisions worth knowing before you extend this package

- **Plain string-literal unions, not TS `enum`.** They serialize identically
  to Postgres text columns and plug directly into `z.enum(...)` without a
  numeric-value footgun crossing a service boundary (e.g. over Redis Streams
  or an HTTP body).
- **`DOCUMENT_TYPE_REGISTRY` is static reference data, not a DB read.** It's
  the fixed shape from the blueprint's document-type registry table. The real
  `document_types` table (migration 004) is the actual source of truth at
  runtime for anything that can change (fee amounts, field_schema JSON,
  per-agency template overrides) — this package only carries the flags and
  classifications that are locked architectural decisions, not operational data.
- **Placeholder agencies are flagged, not hidden.** `BIRTH_CERT`,
  `HEALTH_RECORD`, and `EDUCATION_RECORD` are stubbed against the `NIR` agency
  row today because Ministry of Health / Ministry of Education aren't yet
  onboarded as real `agencies` rows. `issuingAgencyIsPlaceholder: true` on
  those three entries (and `getPlaceholderAgencyDocumentTypes()`) exists so no
  downstream service can silently treat that FK as confirmed. **Open item:**
  once MoH/MoE are onboarded, update `issuingAgency` on those three entries
  and flip `issuingAgencyIsPlaceholder` to `false` — this is a one-line change
  per type, by design.
- **`defaultValidityDays` values for types without a confirmed client-provided
  cycle (Driver's License: 5 years, Vehicle Registration: 1 year, Business
  License: 1 year, Tax Certificate: 1 year) are reasonable planning defaults,
  not confirmed government policy.** They exist so `document-issuance` and
  `citizen-locker-api` have something real to compute expiry/renewal against
  during build. **Open item to send the client:** confirm actual renewal
  cycles per agency before these go live — flagged here rather than treated
  as settled.
- **`AuditLogEvent.metadata` is typed as `Record<string, unknown>`
  deliberately loose.** Per-event-type payload shapes will genuinely differ
  (a `payment.completed` event carries different fields than a
  `consent.grant_revoked` event) and locking that down per event type is real
  scope for `packages/audit-log` (Session 5) once it exists, not this package.
  This package owns the taxonomy of *which* event types exist and the
  envelope around them (hash chain, actor, resource), not every event's
  internal payload schema.
- **Everything is scoped to Liberia specifically, not left generically
  international.** Two concrete places this shows up:
  - `CurrencyCode` is closed to `"LRD" | "USD"` — Liberia's own legal tender
    plus the US dollar it's de facto dollarized with (the blueprint's own
    Traffic Ticket schema confirms real fine amounts are quoted in USD) —
    rather than an open `z.string().length(3)` that would silently accept
    any ISO 4217 code. `payment-engine`/IIPS never needs to move any other
    currency, so the type doesn't pretend otherwise.
  - `phoneNumber` on `User` is validated against `LIBERIA_PHONE_REGEX`
    (`+231` country code, per Lonestar Cell MTN / Orange Liberia, which
    together hold >90% of subscriptions) — not a generic international phone
    format. A non-Liberian number is a real validation error here, not an
    edge case to silently allow.
- **Zero runtime dependencies besides `zod`.** No date library, no lodash —
  timestamps are plain ISO 8601 strings (`z.string().datetime()`), and every
  helper function here is a pure function over plain data. Keeps this package
  trivially importable from Node services, the Next.js web apps, and React
  Native without bundle-size or platform-compat surprises.

## What this package deliberately does NOT cover

- Zod schemas for every one of the ~40+ endpoints implied across all 14
  services — only the contracts explicitly named in the blueprint text
  (issuance, renewal, consent grant/revoke, verify, payment) are modeled here.
  Session-specific request/response shapes not yet named in the blueprint
  (e.g. `reporting-engine`'s dashboard query params) belong in that service's
  own types, not bolted onto this foundation package speculatively.
- Per-document-type `field_schema` JSON (the actual form fields for a
  National ID vs. a Business License) — that lives in the `document_types`
  table (migration 004) as data, not as a TypeScript type, because it's
  config-driven and agency-editable per the blueprint's admin-UI requirement
  (Phase 4).
- Anything requiring a real NIR/eSignet/IIPS/Vault connection — this package
  is pure types and validation, no network calls, no service dependencies.

## Scripts

```bash
npm run build       # tsc -> dist/ (.js + .d.ts + source maps)
npm run typecheck   # tsc --noEmit, strict mode
npm test            # vitest run — 43 tests covering every module
npm run test:watch  # vitest, watch mode
npm run clean       # rm -rf dist
```

## Test coverage summary

- `document-types.test.ts` — registry has all 10 types, exactly 6 flagged
  `isPhase1`, Land Title correctly on LLA (not LRA), requires_review matches
  the risk-tiered workflow, credential format per type, physical-asset-custody
  flag scoped correctly, placeholder agencies correctly identified.
- `agencies.test.ts` — all 6 agencies present and schema-valid.
- `consent.test.ts` — every legal and illegal state transition in the
  `pending_otp -> active -> (expired | revoked)` machine.
- `audit-log.test.ts` — event schema validation, hash-format enforcement,
  taxonomy uniqueness.
- `users.test.ts` — separation-of-duties conflict detection across roles and
  agencies.
- `api.test.ts` — request/response schema validation for documents, consent,
  verification, and payments contracts.
