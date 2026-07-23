import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request as httpsRequest } from "node:https";
import type { Server } from "node:https";
import type { AddressInfo } from "node:net";
import express from "express";
import { buildTlsServerOptions } from "../src/server-options";
import { requireMtls } from "../src/middleware";
import { buildMtlsAgent } from "../src/client";
import { generateRealCerts, generateForeignCert } from "./helpers/real-certs";

/**
 * These tests stand up a REAL HTTPS server using generate-dev-certs.sh's
 * actual openssl-issued certificates and make REAL TLS connections against
 * it (127.0.0.1, real handshake) — nothing here is stubbed. This is what
 * proves requireMtls behaves correctly under an actual mutual-TLS
 * handshake, not just against synthetic objects shaped like a TLSSocket.
 */

const certs = generateRealCerts(["auth", "document-issuance", "payment-engine"]);
afterAll(() => certs.cleanup());

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();

  app.get("/open", requireMtls(), (req, res) => {
    res.json({ caller: req.mtls?.serviceName });
  });

  app.get("/payments-only", requireMtls({ allowedServiceNames: ["payment-engine"] }), (req, res) => {
    res.json({ caller: req.mtls?.serviceName });
  });

  const svc = certs.service("auth");
  const tlsOptions = buildTlsServerOptions({ ...svc, caPath: certs.caPath });
  server = createServer(tlsOptions, app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // "localhost", not the numeric IP: the leaf certs' SAN list is DNS names
  // only (matching how services actually address each other — by service
  // DNS name in docker-compose/k8s, never by raw IP), so the client's
  // hostname-verification step needs a hostname that's in that SAN list.
  baseUrl = `https://localhost:${port}`;
});

afterAll(() => {
  server.close();
});

function get(path: string, agentPaths: { certPath: string; keyPath: string } | null): Promise<{
  status: number;
  body: any;
}> {
  return new Promise((resolve, reject) => {
    const agent = agentPaths ? buildMtlsAgent({ ...agentPaths, caPath: certs.caPath }) : undefined;
    const req = httpsRequest(
      `${baseUrl}${path}`,
      { agent, rejectUnauthorized: false }, // client-side: we're testing server auth behavior, not validating the server's own cert here
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("requireMtls over a real mTLS handshake", () => {
  it("accepts a valid, CA-signed client certificate and extracts its identity", async () => {
    const res = await get("/open", certs.service("document-issuance"));
    expect(res.status).toBe(200);
    expect(res.body.caller).toBe("document-issuance");
  });

  it("rejects a request with no client certificate at all (401)", async () => {
    const res = await get("/open", null);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("PeerCertMissingError");
  });

  it("rejects a genuinely untrusted (foreign CA) client certificate (401)", async () => {
    const foreign = generateForeignCert(certs.dir, "impostor");
    const res = await get("/open", foreign);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("PeerCertUntrustedError");
  });

  it("allows an allowlisted caller through a scoped endpoint", async () => {
    const res = await get("/payments-only", certs.service("payment-engine"));
    expect(res.status).toBe(200);
    expect(res.body.caller).toBe("payment-engine");
  });

  it("rejects a CA-trusted but non-allowlisted caller on a scoped endpoint (403)", async () => {
    const res = await get("/payments-only", certs.service("auth"));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PeerNotAuthorizedError");
  });
});
