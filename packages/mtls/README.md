# @liberia-locker/mtls

Phase 0 shared package (Session 3). Mutual TLS between all internal services,
per the master blueprint's Phase 0 requirement: *"Service-to-service auth:
mTLS between all internal services + signed payload envelopes."* This
package covers the mTLS half; signed payload envelopes are a separate,
not-yet-built concern (referenced in the blueprint alongside Redis Streams,
not scoped into this session).

## What this solves

Every one of the 14 services calls every other service over HTTPS. Each
call must be mutually authenticated: the callee must know which service is
calling it (not just that *some* HTTPS client connected), and the caller
must know it's actually talking to the real callee, not something spoofed
on the internal network.

## Setup — generate dev certificates first

This package does **not** ship pre-generated certificates. Before running
any service locally, or running this package's own test suite, generate a
dev CA and per-service leaf certs:

```bash
# from the repo root
bash infra/scripts/generate-dev-certs.sh certs/dev
```

This creates:

```
certs/dev/ca/ca.crt              # trust anchor — every service's caPath points here
certs/dev/ca/ca.key              # dev-only CA private key
certs/dev/<service>/<service>.crt
certs/dev/<service>/<service>.key
```

`certs/dev/` is gitignored — never commit generated key material, even
dev-only. Re-running the script is idempotent for the CA (reuses the
existing `ca.key` unless you delete it) and re-issues only the service
names you pass on the command line, so rotating one service's cert doesn't
touch anyone else's.

**This is a dev/CI-only CA.** Production certificate issuance is a real,
unbuilt concern — see "Production gap" below.

## Usage

### Server side (terminating mTLS + enforcing it per-route)

```ts
import { createServer } from "node:https";
import express from "express";
import { buildTlsServerOptions, requireMtls } from "@liberia-locker/mtls";

const app = express();

// Open to any CA-trusted caller:
app.get("/health", requireMtls(), (req, res) => {
  res.json({ ok: true, calledBy: req.mtls?.serviceName });
});

// Restricted to specific named callers:
app.post(
  "/internal/rotate-key",
  requireMtls({ allowedServiceNames: ["admin-api"] }),
  (req, res) => { /* ... */ },
);

const tlsOptions = buildTlsServerOptions({
  certPath: process.env.MTLS_CERT_PATH!,
  keyPath: process.env.MTLS_KEY_PATH!,
  caPath: process.env.MTLS_CA_PATH!,
});

createServer(tlsOptions, app).listen(443);
```

**`requireMtls` is mandatory on every mTLS-protected route**, not optional
defense-in-depth — see "Why `rejectUnauthorized: false`" below for why the
transport layer alone does not enforce this.

### Client side (calling another service)

```ts
import { buildMtlsAgent } from "@liberia-locker/mtls";
import { request } from "node:https";

const agent = buildMtlsAgent({
  certPath: process.env.MTLS_CERT_PATH!,
  keyPath: process.env.MTLS_KEY_PATH!,
  caPath: process.env.MTLS_CA_PATH!,
});

request("https://payment-engine.internal/v1/charge", { agent, method: "POST" }, (res) => {
  /* ... */
}).end(JSON.stringify(payload));
```

Every outbound service-to-service call should use an agent built this way
(directly, or later via `http-kit`'s client once that package wraps this).

### Certificate rotation (no restart)

```ts
import { watchCertsForRotation } from "@liberia-locker/mtls";

const stop = watchCertsForRotation({
  certPath: process.env.MTLS_CERT_PATH!,
  keyPath: process.env.MTLS_KEY_PATH!,
  caPath: process.env.MTLS_CA_PATH!,
  server: httpsServer,
  onRotated: (paths) => logger.info("mTLS cert rotated", paths),
  onError: (err) => logger.error("mTLS cert rotation failed, keeping previous cert", err),
});

// on graceful shutdown:
stop();
```

On rotation failure (e.g. a partially-written file mid-rewrite), the
server keeps serving its previous, still-valid credentials — a failed
reload never takes the server down.

## Why `rejectUnauthorized: false` in `buildTlsServerOptions`

This is the one non-obvious design decision in this package, so it's worth
stating plainly here as well as in the code comment (`server-options.ts`):

`buildTlsServerOptions` sets `requestCert: true` but `rejectUnauthorized:
false`. Node still populates `socket.authorized` / `socket.authorizationError`
correctly regardless of this flag — the actual cryptographic trust
decision (is this cert signed by our CA, is it expired, etc.) still happens
in Node's real TLS layer, exactly as it would with `rejectUnauthorized:
true`.

What changes is *what happens after* an untrusted or missing certificate is
detected:

- `rejectUnauthorized: true` → Node terminates the raw TCP connection
  before any application code runs. The caller sees a connection reset with
  no machine-readable detail, and there is no hook to write an audit-log
  entry about the rejected call.
- `rejectUnauthorized: false` (this package's choice) → the connection
  completes, the request reaches Express, and `requireMtls` makes the
  rejection decision itself — returning a proper `401`/`403` JSON body
  (`PeerCertMissingError` / `PeerCertUntrustedError` / `PeerNotAuthorizedError`)
  and giving callers (`onRejected`) a hook to log the attempt.

**The tradeoff this creates:** there is no enforcement left at the
transport layer. If a route is ever mounted on an mTLS-configured
`https.Server` *without* `requireMtls` in its middleware chain, that route
is reachable by anyone, cert or no cert. Every service built against this
package must apply `requireMtls` to every route that should be
internal-only — there is no "secure by default at the socket level"
fallback to catch a missed route.

## Production gap

**Real HSM/production-grade PKI for issuing and rotating service
certificates is not built here and remains out of scope for this session**,
consistent with the client-side HSM blocker already noted in
`packages/kms`. This package's cryptographic logic (`buildTlsServerOptions`,
`requirePeerIdentity`, `watchCertsForRotation`) is CA-agnostic — it works
identically against a real production CA's certs — but the CA itself
(`infra/scripts/generate-dev-certs.sh`) is dev/CI-only and must not be used
to issue production service certificates. Standing up a real internal CA
(or a managed PKI service) for production is unbuilt and should be raised
as an open item alongside the HSM gap, not assumed solved by this package.

## Testing

```bash
npm run certs:dev   # or: bash ../../infra/scripts/generate-dev-certs.sh
npm test
```

The test suite generates its own real, throwaway CA and leaf certificates
per run (via `test/helpers/real-certs.ts`, which shells out to the actual
`generate-dev-certs.sh`) into a temp directory — it does not depend on or
reuse `certs/dev/`. All tests exercise real openssl-issued X.509
certificates and real TLS handshakes over `localhost`; nothing is mocked.
Covers: valid-caller acceptance, no-cert rejection, foreign-CA-cert
rejection, per-endpoint allowlist enforcement (403 vs 401), live cert
rotation without server restart, and graceful handling of a corrupted
rotation attempt.

## Exports

| Export | Purpose |
|---|---|
| `buildTlsServerOptions(paths)` | HTTPS server options for terminating mTLS |
| `buildSecureContext(paths)` | Raw `tls.SecureContext`, used internally by `watchCertsForRotation` |
| `requireMtls(options?)` | Express middleware: authenticates + authorizes the caller, sets `req.mtls` |
| `requirePeerIdentity(socket)` | Lower-level: validate + extract identity from a `TLSSocket` directly |
| `assertPeerAuthorized(identity, allowedServiceNames?)` | Pure allowlist check |
| `buildMtlsAgent(paths)` | `https.Agent` for outbound service-to-service calls |
| `watchCertsForRotation(options)` | Hot-reloads a running server's TLS credentials on cert rotation |
| `MtlsError` and subclasses | Typed errors: `CertFileNotFoundError`, `PeerCertMissingError`, `PeerCertUntrustedError`, `PeerNotAuthorizedError`, `CertRotationError` |
