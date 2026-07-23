# @liberia-locker/db

Schema, migrations, and RLS session-context helpers for the Liberia National
Digital Document Locker Platform. Foundation package — everything downstream
(`packages/audit-log` onward, and eventually all 14 services) depends on the
tables, roles, and RLS policies this package creates.

## What's in here

Four migrations, applied in order, each one idempotent and checksum-verified
by the runner:

| File | Creates |
|---|---|
| `001_extensions.sql` | `pgcrypto`, `citext` extensions; `schema_migrations` bookkeeping table |
| `002_agencies_users_roles.sql` | `agencies` (6 seeded rows), `users` (all 4 `user_types`), `roles` (5 seeded rows), `user_roles` ABAC join, and the separation-of-duties trigger |
| `003_rls_foundation.sql` | `locker_app` runtime role (no DELETE grant, ever), session-context GUC helper functions, RLS policies on `agencies`/`roles`/`users`/`user_roles` |
| `004_document_types_registry.sql` | `document_types` config-driven registry, all 10 types seeded with real sourced `field_schema` |
| `005_citizen_self_registration.sql` | `register_citizen()` `SECURITY DEFINER` function — sole insert path for a new citizen's `users` row |
| `006_role_revocation.sql` | `user_roles` revocation (`revoked_at`/`revoked_by`), `UPDATE` RLS policy, revocation-only immutability trigger, separation-of-duties honors revocation |
| `migrations/pending/007_agency_onboarding_moh_moe.sql` | **Not auto-applied.** Onboards MOH/MOE agencies, repoints `BIRTH_CERT`/`HEALTH_RECORD`/`EDUCATION_RECORD` — gated on client confirmation, see Known gaps |

Seed data mirrors `@liberia-locker/shared-types`' `enums.ts` / `agencies.ts` /
`document-types.ts` exactly. **If the two ever need to diverge, change
shared-types first and update these migrations to match — never the
other way around.** shared-types has no dependency on this package (or any
package), so it's always the safer source of truth to edit first.

## Contract every other service must follow

### Connect as `locker_app`, never as the migration/owner role

Migrations must be run by a privileged/owner role (whatever role owns the
Postgres database — `postgres` in dev, a dedicated migration role in
production). **Services must never connect to Postgres as that owner role.**
Table owners bypass Row-Level Security by default — connecting as the owner
silently disables every RLS policy in this package with no error to tell you
it happened. Always connect application traffic as `locker_app`.

`locker_app` has `SELECT`, `INSERT`, `UPDATE` on every table this package
creates — **never `DELETE`**. Nothing on this platform is ever hard-deleted;
this is enforced both by omission (`locker_app` was never granted it) and by
an explicit `REVOKE DELETE` in `003_rls_foundation.sql`, so it's a decision
recorded in the migration, not just an absence someone could accidentally
grant back without noticing it mattered.

`locker_app` has no password set by this migration. Set one out-of-band via
`ALTER ROLE locker_app WITH PASSWORD '...'` from a secrets-managed script
(Vault / AWS Secrets Manager) — the same pattern already used for Trestle's
Stripe webhook secret. Never commit a real credential in a migration file.

### Set session context every request, via `withSessionContext`

RLS policies in `003_rls_foundation.sql` key off three GUCs
(`app.current_user_id`, `app.current_user_type`, `app.current_agency_id`)
that must be set **per transaction**, immediately after authenticating a
request. Use `withSessionContext()` from this package rather than setting
them by hand:

```ts
import { Pool } from "pg";
import { withSessionContext } from "@liberia-locker/db";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const documents = await withSessionContext(
  pool,
  { userId: req.user.id, userType: req.user.userType, agencyId: req.user.agencyId },
  async (client) => (await client.query("SELECT * FROM documents")).rows,
);
```

This wraps the callback in a transaction and uses `SET LOCAL` under the hood
— never plain `SET` — because `SET` persists on the pooled connection and
leaks into whichever unrelated request borrows that connection next.
`userType: "SERVICE"` is the convention for service-to-service calls
authenticated via `packages/mtls` rather than a human session; no RLS policy
in this package currently grants `SERVICE` special access — add that
explicitly in whichever service's own migration needs it, don't assume it
here.

### Running migrations

```bash
DATABASE_URL="postgresql://user:pass@host:5432/dbname" npm run migrate
```

Safe to run repeatedly — already-applied migrations are skipped. If an
already-applied migration's file content no longer matches its recorded
checksum, the runner throws rather than silently re-running or skipping it.
**Never edit an applied migration file — write a new one instead.**

## Known gaps

- **Citizen self-registration — resolved in `005_citizen_self_registration.sql`.**
  A `SECURITY DEFINER` function `register_citizen(full_name, national_id_number,
  phone_number)` is the sole insert path for a brand-new citizen row, granted
  to `locker_app` via `EXECUTE` only — no broader `INSERT` grant on `users`.
  Scope boundary that still stands: this function does not perform NIR
  verification, OTP confirmation, or passport/voter-ID fallback matching —
  that sequencing belongs to `auth`'s real registration flow (not yet built).
  `auth` calls this function only after its own verification succeeds.
- **`user_roles` revocation — resolved in `006_role_revocation.sql`.**
  Added `revoked_at`/`revoked_by` columns, an `UPDATE` RLS policy
  (platform_admin, or agency_supervisor within their own agency — previously
  there was no `UPDATE` policy on this table at all), and a trigger that
  restricts that `UPDATE` to revocation only (`user_id`/`role`/`agency_id`/
  `granted_at`/`granted_by` stay immutable). `enforce_separation_of_duties()`
  (002) was redefined to only count `revoked_at IS NULL` grants as conflicts —
  otherwise a revoked `ISSUER` grant would still block a new `APPROVER` grant
  for the same user/agency. Any future "does this user hold role X" query
  elsewhere in the platform must add `WHERE revoked_at IS NULL`; a partial
  index (`user_roles_active_lookup_idx`) makes that the fast path too.
- **3 document types stubbed against a placeholder issuing agency — fix
  written, not yet applied.** `migrations/pending/007_agency_onboarding_moh_moe.sql`
  onboards MOH/MOE as real `agencies` rows and repoints `BIRTH_CERT`/
  `HEALTH_RECORD`/`EDUCATION_RECORD` at them. It's deliberately kept in
  `migrations/pending/`, outside the directory `src/migrate.ts` scans, because
  onboarding MOH/MOE is a client/business confirmation this repo can't make
  unilaterally. It also widens `agencies`' `code` CHECK constraint, which
  currently only allows the 6 seeded codes — apply that ALTER before moving
  this file into `migrations/`. Note `HEALTH_RECORD` has a second, separate
  blocker even after this runs: MoH's EMR/EHR system is still an open 2026
  procurement notice with nothing live to integrate against, so
  `issuing_agency_is_placeholder = false` for it should not be read as
  "ready to build" — check `document-issuance`'s session prompt too.
- **Retention periods are not yet in this schema.** No confirmed Liberian
  statute exists for document retention — that's explicitly Session 6's
  scope (`documents`/`document_versions`), not this package's.

## Testing

```bash
npm test              # unit tests only — no database required
npm run test:integration   # real migrations against DATABASE_URL, full RLS + trigger verification
npm run test:all      # both
```

The integration suite (`test/schema.integration.test.ts`) is not a mock —
it runs all 4 migrations against a real Postgres 16 database and asserts on
real behavior: seed row counts, the separation-of-duties trigger rejecting a
conflicting role grant, `locker_app` actually being denied `DELETE`, and RLS
actually scoping what a citizen session vs. a platform_admin session can see.
Point `DATABASE_URL` at a disposable database — this suite creates real
tables, roles, and rows in it.
