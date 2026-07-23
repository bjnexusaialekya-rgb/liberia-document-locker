# @liberia-locker/http-kit

Shared HTTP client/server utilities used as the base every service imports
for its HTTP layer. Built per the master blueprint's Phase 0 deliverable:
*"Shared middleware library, used by all 6 services: standard error shape,
retry-with-backoff, idempotency-key enforcement, timeout budgets."*

Session 4 of 26. Depends on `@liberia-locker/shared-types` (Session 1) —
**this version is wired against the real package**, verified by
typechecking and running the full test suite against the actual
`packages/shared-types/src/api/common.ts` source, not a guess. See
**Integration notes** below for exactly what was checked and one thing
still worth a second look.

## What's in here

| Module | Purpose |
|---|---|
| `errors.ts` | `ApiError` class, matching shared-types' `ApiErrorShape` exactly. The one error type every service should throw. |
| `validation.ts` | `validateRequest()` Express middleware — validates `body`/`query`/`params`/`headers` against zod schemas, collects **all** field errors in one response. |
| `idempotency.ts` | `idempotency()` Express middleware + pluggable `IdempotencyStore`. Enforces shared-types' `Idempotency-Key` header (UUID format, per `IdempotencyKeySchema`), replays completed responses, rejects key-reuse-with-different-payload and concurrent in-flight reuse. |
| `retry.ts` | `withRetry()` — exponential backoff with full jitter, pluggable retry predicate. Used internally by `HttpClient`, but exported standalone for any other retryable operation. |
| `client.ts` | `HttpClient` — the wrapper every service uses to call another service: timeout, retry, auto idempotency-key injection on POST/PATCH, standard error mapping. |
| `server.ts` | `requestId()`, `errorHandler()`, `asyncHandler()`, `sendSuccess()`, `requestLogging()` — Express bootstrap pieces every service mounts. Also defines `ApiSuccessEnvelope` (http-kit's own — see Integration notes). |
| `logging.ts` | `HttpLogHooks` interface + `Logger` interface + a redacting `consoleLogger` default. No logging backend is chosen for you. |

## Quick start

**Server side (per service):**

```ts
import express from "express";
import {
  requestId,
  requestLogging,
  errorHandler,
  asyncHandler,
  validateRequest,
  idempotency,
  InMemoryIdempotencyStore,
  sendSuccess,
  ApiError,
  hooksFromLogger,
  consoleLogger,
} from "@liberia-locker/http-kit";
import { z } from "zod";

const hooks = hooksFromLogger(consoleLogger); // swap for your real logger
const app = express();

app.use(express.json());
app.use(requestId());
app.use(requestLogging(hooks));

app.post(
  "/documents",
  idempotency({ store: new InMemoryIdempotencyStore() }), // swap for Redis in prod, see Integration notes
  validateRequest({ body: z.object({ documentType: z.string() }) }),
  asyncHandler(async (req, res) => {
    if (!req.validated?.body) throw ApiError.internal();
    const doc = await createDocument(req.validated.body);
    sendSuccess(req, res, doc, 201);
  }),
);

// Mount LAST, after every route.
app.use(errorHandler(hooks));
```

**Client side (calling another service):**

```ts
import { HttpClient, hooksFromLogger, consoleLogger } from "@liberia-locker/http-kit";

const auditLog = new HttpClient({
  baseUrl: "https://audit-log.internal",
  timeoutMs: 5000,
  retry: { maxAttempts: 3 },
  hooks: hooksFromLogger(consoleLogger),
});

// POST auto-generates a valid-UUID Idempotency-Key if you don't supply one.
await auditLog.request({ method: "POST", path: "/events", body: { ... } });
```

## Standard error shape

Matches `@liberia-locker/shared-types`' `ApiErrorShape` exactly:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request failed validation.",
    "requestId": "b2b1...",
    "details": { "issues": [{ "path": "body.documentType", "message": "Required" }] }
  }
}
```

Two things worth knowing about `code` and `details`:

- **`code` is not a closed enum.** shared-types types it as plain `string`
  (services mint their own, e.g. `"CONSENT_NOT_ACTIVE"`). http-kit's
  `ApiError` accepts any string; a `WellKnownErrorCode` union (exported
  from `errors.ts`) covers the common platform-wide codes and gets an
  automatic HTTP status via `ERROR_CODE_STATUS`. For anything else, use
  `ApiError.custom(code, status, message)` — `status` is required there
  since there's no platform default to fall back on.
- **`details` is `Record<string, unknown>`, not an array.** Validation
  errors put their per-field issues under `details.issues` (an array of
  `{ path, message }`) rather than making `details` itself an array —
  this matches shared-types' typing, which is a record, not a list.

Unexpected (non-`ApiError`) exceptions are always mapped to a generic
`INTERNAL_ERROR` with a fixed message — the real error is passed to your
logging hook via `cause`, never put on the wire. This was actually caught
and fixed by this session's own test suite (`errors.test.ts`) — an
earlier draft leaked the raw exception message to clients.

## Idempotency-key handling

Uses shared-types' `IDEMPOTENCY_KEY_HEADER` (`"Idempotency-Key"`) and
`IdempotencyKeySchema` (`z.string().uuid()`) directly, so the header name
and key format can't drift between packages. Enforced by default on
`POST`/`PATCH`:

- **Missing key on an enforced method** → `400 IDEMPOTENCY_KEY_REQUIRED`.
- **Key present but not a valid UUID** → `400 IDEMPOTENCY_KEY_INVALID`
  (rejected explicitly rather than silently treated as a fresh key — a
  client sending a malformed key on every retry would otherwise get zero
  idempotency protection with no error telling them why).
- **Same key, same payload, first request still processing** → `409 CONFLICT`.
- **Same key, same payload, first request completed** → the original
  response is replayed verbatim; the route handler is **not** re-invoked.
- **Same key, different payload** → `422 IDEMPOTENCY_KEY_REPLAY_MISMATCH`
  (never silently reused — the blueprint calls this out as the case that
  would double-credit a payment if handled wrong).

This is intentionally general-purpose. **`payment-engine` (a later
session) is the actual consumer this was built for**, per the master
blueprint's note that IIPS's documented reliability issues make idempotent
payment confirmation non-optional. That session will wire this middleware
with its own store and TTL.

## Retry/backoff

`withRetry()` and `HttpClient`'s built-in retry use exponential backoff
with **full jitter** (`delay = random(0, min(maxDelayMs, base * 2^attempt))`)
to avoid retry storms. Default predicate retries network errors, `429`,
and `5xx`; never retries other `4xx` (those mean the request itself is
wrong, and retrying it will fail identically).

## Integration notes — what was actually verified against shared-types

Session 3's guidance said to attach the real dependency, not a
description of it — that didn't happen for this session, so rather than
guessing, the real `packages/shared-types/src/api/common.ts` source was
pasted in-conversation and used verbatim (not paraphrased or
reconstructed from memory) to typecheck and run this package's full test
suite against it. What that caught and fixed, versus an earlier draft
built on a guessed shape:

- **Package name**: real package is `@liberia-locker/shared-types`, not
  `@liberia-document-locker/*` — this package (and its own name) were
  renamed to match (`@liberia-locker/http-kit`). If your monorepo's
  scope is actually `@liberia-document-locker/*` for some packages and
  `@liberia-locker/*` for others, flag that inconsistency — it wasn't
  something this session could resolve from the outside.
- **`ApiErrorShape.error.code` is `string`**, not a closed union — fixed,
  see "Standard error shape" above.
- **`ApiErrorShape.error.details` is `Record<string, unknown>`**, not an
  array — fixed, validation issues now nest under `details.issues`.
- **No `timestamp` field** on `ApiErrorShape` — an earlier draft included
  one; removed to match exactly.
- **`Idempotency-Key` is `IdempotencyKeySchema` (`z.string().uuid()`)** —
  an earlier draft only checked presence, not format. Fixed: malformed
  keys are now rejected with `IDEMPOTENCY_KEY_INVALID`.

One thing **not** resolved, flagged rather than guessed:

- **`shared-types` has no success-envelope type** — only `ApiErrorShape`,
  `PaginationParams`/`PaginatedResponse`. `ApiSuccessEnvelope` (in
  `server.ts`, used by `sendSuccess()`) is http-kit's own convention, kept
  symmetric with `ApiErrorShape`'s `requestId` field. If a real success
  envelope gets added to `shared-types` later, switch `server.ts` to
  import it instead of defining its own.

## Known gaps — read before trusting this in production

1. **`InMemoryIdempotencyStore` is dev/test-only.** It does not survive a
   process restart and does not work across multiple instances of the same
   service — both of which real idempotency guarantees require, especially
   for `payment-engine`. Production services must supply their own
   `IdempotencyStore` implementation (Redis-backed, with TTL) conforming to
   the same interface exported from `idempotency.ts`. Building that Redis
   store is out of scope for this session — it's infra, not this package's
   in-process logic — and is called out here so it isn't silently assumed
   to already exist.

2. **No circuit breaker.** Retry/backoff is implemented; a circuit breaker
   (to stop hammering a dependency that's fully down, rather than retrying
   every request against it) is not. Not called for by this session's scope,
   flagged in case it's assumed to be bundled with "retry/backoff" later.

3. **`HttpClient` timeout uses `AbortController`**, which requires a
   `fetch` implementation that honors `signal` (Node's built-in `fetch`,
   available in Node 18+, does). If a service swaps in a different fetch
   implementation via `fetchImpl`, confirm it respects abort signals or
   timeouts will silently not fire.

## Testing

```bash
npm install
npm run typecheck   # strict TS, exactOptionalPropertyTypes on
npm test            # 43 tests, vitest
npm run build       # emits dist/ (ESM + .d.ts)
```

Test coverage: standard-error-code→status mapping (incl. custom
non-well-known codes), no-leak-on-internal-error, validation multi-field
error collection, idempotency replay/mismatch/conflict/TTL/invalid-format,
retry backoff bounds + default retry predicate, HttpClient auto
idempotency-key injection (real UUID, correct header casing), retry-on-5xx/
no-retry-on-4xx, timeout→UPSTREAM_TIMEOUT mapping, non-standard upstream
error bodies not crashing the client, request-id propagation/echo,
errorHandler mapping for both `ApiError` and unexpected `Error` throws, and
`asyncHandler` forwarding rejected promises correctly.
