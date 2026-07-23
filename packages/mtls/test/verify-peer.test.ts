import { describe, it, expect } from "vitest";
import { assertPeerAuthorized } from "../src/verify-peer";
import { PeerNotAuthorizedError } from "../src/errors";
import type { PeerIdentity } from "../src/types";

const identity: PeerIdentity = {
  serviceName: "document-issuance",
  sanDnsNames: ["document-issuance", "localhost"],
  fingerprint256: "AA:BB",
  validTo: new Date().toISOString(),
};

describe("assertPeerAuthorized", () => {
  it("allows any CA-trusted caller when no allowlist is configured", () => {
    expect(() => assertPeerAuthorized(identity, undefined)).not.toThrow();
    expect(() => assertPeerAuthorized(identity, [])).not.toThrow();
  });

  it("allows a caller whose service name is on the allowlist", () => {
    expect(() => assertPeerAuthorized(identity, ["document-issuance", "auth"])).not.toThrow();
  });

  it("rejects a CA-trusted caller not on the allowlist", () => {
    expect(() => assertPeerAuthorized(identity, ["payment-engine"])).toThrow(PeerNotAuthorizedError);
  });
});
