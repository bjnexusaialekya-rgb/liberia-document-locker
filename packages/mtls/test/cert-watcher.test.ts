import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:https";
import type { Server } from "node:https";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTlsServerOptions } from "../src/server-options";
import { watchCertsForRotation } from "../src/cert-watcher";
import { generateRealCerts } from "./helpers/real-certs";

const certs = generateRealCerts(["auth"]);

let server: Server | undefined;
let stopWatching: (() => void) | undefined;

afterEach(() => {
  stopWatching?.();
  stopWatching = undefined;
  server?.close();
  server = undefined;
});

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("watchCertsForRotation", () => {
  it("hot-reloads a running server's TLS credentials after a real cert re-issue, without restarting", async () => {
    const svc = certs.service("auth");
    const paths = { ...svc, caPath: certs.caPath };

    server = createServer(buildTlsServerOptions(paths));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

    let rotatedCount = 0;
    let lastError: unknown;

    stopWatching = watchCertsForRotation({
      ...paths,
      server: server as unknown as Parameters<typeof watchCertsForRotation>[0]["server"],
      debounceMs: 50,
      onRotated: () => {
        rotatedCount += 1;
      },
      onError: (err) => {
        lastError = err;
      },
    });

    const beforeCert = readFileSync(svc.certPath, "utf8");

    // Re-issue the SAME service's leaf cert for real — this rewrites
    // auth.crt/auth.key in place, which is exactly what a real rotation
    // (or a renewed real-PKI cert in production) looks like on disk.
    execFileSync("bash", [
      join(__dirname, "..", "..", "..", "infra", "scripts", "generate-dev-certs.sh"),
      certs.dir,
      "auth",
    ]);

    const afterCert = readFileSync(svc.certPath, "utf8");
    expect(afterCert).not.toBe(beforeCert); // confirms the file genuinely changed (new keypair)

    await waitFor(() => rotatedCount > 0);
    expect(lastError).toBeUndefined();
  });

  it("reports a CertRotationError and keeps serving when a rotation attempt writes invalid material", async () => {
    const svc = certs.service("auth");
    const paths = { ...svc, caPath: certs.caPath };

    server = createServer(buildTlsServerOptions(paths));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

    let errorCount = 0;

    stopWatching = watchCertsForRotation({
      ...paths,
      server: server as unknown as Parameters<typeof watchCertsForRotation>[0]["server"],
      debounceMs: 50,
      onError: () => {
        errorCount += 1;
      },
    });

    // Corrupt the cert file with real garbage bytes (not valid PEM) —
    // buildSecureContext will genuinely fail to parse this, exercising the
    // real openssl/Node PEM parser's failure path rather than a mock throw.
    writeFileSync(svc.certPath, "not a real certificate\n");

    await waitFor(() => errorCount > 0);
    expect(server.listening).toBe(true); // server keeps its previous, still-valid context
  });
});
