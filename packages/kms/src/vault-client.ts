/**
 * Real HashiCorp Vault HTTP API client — Transit secrets engine + a minimal
 * slice of `sys/*` needed for bootstrap and the Shamir unseal handover.
 *
 * `IVaultClient` is the seam the rest of this package depends on. In
 * production and in integration tests, `HttpVaultClient` (below) is the
 * only implementation — it makes real HTTP calls to a real Vault, and the
 * on-the-wire ciphertext format ("vault:v1:base64...") is Vault's own, not
 * anything this package invents. Unit tests for orchestration logic that
 * *isn't* the crypto itself (crypto-shredding bookkeeping, key-tier
 * validation, etc.) are allowed to inject a fake implementing this same
 * interface — see test/README note in the package README — but the
 * encrypt/decrypt/rotate code path itself is never reimplemented locally.
 */

import { VaultApiError, VaultSealedError, VaultUnreachableError } from "./errors";

export interface VaultClientConfig {
  /** e.g. http://127.0.0.1:8200 */
  addr: string;
  /** Vault token with policy access to the transit mount (and sys/* for bootstrap-only calls). */
  token: string;
  /** Transit secrets engine mount path. Default: "transit". */
  transitMount?: string;
  /** Optional Vault Enterprise namespace. */
  namespace?: string;
  /** Request timeout in ms. Default: 5000. */
  timeoutMs?: number;
}

export interface TransitEncryptResult {
  /** Vault's own envelope format, e.g. "vault:v1:base64ciphertext...". */
  ciphertext: string;
}

export interface TransitDecryptResult {
  /** base64-encoded plaintext, as returned by Vault. */
  plaintext: string;
}

export interface TransitDataKeyResult {
  /** base64-encoded raw plaintext data key. Caller must zero/discard after use — never persisted. */
  plaintext: string;
  /** The data key wrapped (encrypted) by the named Transit key. This is what gets persisted. */
  ciphertext: string;
}

export interface VaultKeyInfo {
  name: string;
  type: string;
  latestVersion: number;
  minDecryptionVersion: number;
  deletionAllowed: boolean;
}

export interface VaultInitResult {
  rootToken: string;
  keyShares: string[];
}

export interface VaultSealStatus {
  sealed: boolean;
  t: number; // threshold
  n: number; // total shares
  progress: number;
}

export interface IVaultClient {
  health(): Promise<{ initialized: boolean; sealed: boolean }>;
  ensureTransitEngineEnabled(): Promise<void>;
  keyExists(keyName: string): Promise<boolean>;
  createKey(keyName: string, opts?: { exportable?: boolean }): Promise<void>;
  getKeyInfo(keyName: string): Promise<VaultKeyInfo>;
  rotateKey(keyName: string): Promise<{ latestVersion: number }>;
  rewrap(keyName: string, ciphertext: string): Promise<TransitEncryptResult>;
  encrypt(keyName: string, plaintextBase64: string, context?: Record<string, string>): Promise<TransitEncryptResult>;
  decrypt(keyName: string, ciphertext: string, context?: Record<string, string>): Promise<TransitDecryptResult>;
  generateDataKey(keyName: string): Promise<TransitDataKeyResult>;
  allowKeyDeletion(keyName: string): Promise<void>;
  deleteKey(keyName: string): Promise<void>;

  // sys/* — bootstrap + Shamir unseal handover only. Not used in the hot path.
  initStatus(): Promise<{ initialized: boolean }>;
  init(secretShares: number, secretThreshold: number): Promise<VaultInitResult>;
  sealStatus(): Promise<VaultSealStatus>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TRANSIT_MOUNT = "transit";

export class HttpVaultClient implements IVaultClient {
  private readonly addr: string;
  private readonly token: string;
  private readonly mount: string;
  private readonly namespace: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: VaultClientConfig) {
    this.addr = config.addr.replace(/\/+$/, "");
    this.token = config.token;
    this.mount = config.transitMount ?? DEFAULT_TRANSIT_MOUNT;
    this.namespace = config.namespace;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.addr}/v1/${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          "X-Vault-Token": this.token,
          "Content-Type": "application/json",
          ...(this.namespace ? { "X-Vault-Namespace": this.namespace } : {}),
        },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await fetch(url, init);
    } catch (err) {
      throw new VaultUnreachableError(this.addr, err);
    } finally {
      clearTimeout(timer);
    }

    // Vault returns 204 for some successful writes with no body.
    const text = await res.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined;

    if (res.status === 503) {
      // Vault's convention: 503 on transit ops commonly means sealed.
      const errs = (parsed as { errors?: string[] } | undefined)?.errors ?? [];
      if (errs.some((e) => /sealed/i.test(e))) throw new VaultSealedError();
    }
    if (!res.ok) {
      throw new VaultApiError(res.status, path, parsed);
    }
    return parsed as T;
  }

  async health(): Promise<{ initialized: boolean; sealed: boolean }> {
    const data = await this.request<{ initialized: boolean; sealed: boolean }>(
      "GET",
      "sys/health?standbyok=true&sealedcode=200&uninitcode=200",
    );
    return { initialized: data.initialized, sealed: data.sealed };
  }

  async ensureTransitEngineEnabled(): Promise<void> {
    const mounts = await this.request<{ data: Record<string, { type: string }> }>(
      "GET",
      "sys/mounts",
    );
    const key = `${this.mount}/`;
    if (mounts.data[key]?.type === "transit") return;
    await this.request("POST", "sys/mounts/" + this.mount, { type: "transit" });
  }

  async keyExists(keyName: string): Promise<boolean> {
    try {
      await this.getKeyInfo(keyName);
      return true;
    } catch (err) {
      if (err instanceof VaultApiError && err.status === 404) return false;
      throw err;
    }
  }

  async createKey(keyName: string, opts: { exportable?: boolean } = {}): Promise<void> {
    await this.request("POST", `${this.mount}/keys/${encodeURIComponent(keyName)}`, {
      type: "aes256-gcm96",
      exportable: opts.exportable ?? false,
    });
  }

  async getKeyInfo(keyName: string): Promise<VaultKeyInfo> {
    const res = await this.request<{
      data: {
        name: string;
        type: string;
        latest_version: number;
        min_decryption_version: number;
        deletion_allowed: boolean;
      };
    }>("GET", `${this.mount}/keys/${encodeURIComponent(keyName)}`);
    return {
      name: res.data.name,
      type: res.data.type,
      latestVersion: res.data.latest_version,
      minDecryptionVersion: res.data.min_decryption_version,
      deletionAllowed: res.data.deletion_allowed,
    };
  }

  async rotateKey(keyName: string): Promise<{ latestVersion: number }> {
    await this.request("POST", `${this.mount}/keys/${encodeURIComponent(keyName)}/rotate`);
    const info = await this.getKeyInfo(keyName);
    return { latestVersion: info.latestVersion };
  }

  async rewrap(keyName: string, ciphertext: string): Promise<TransitEncryptResult> {
    const res = await this.request<{ data: { ciphertext: string } }>(
      "POST",
      `${this.mount}/rewrap/${encodeURIComponent(keyName)}`,
      { ciphertext },
    );
    return { ciphertext: res.data.ciphertext };
  }

  async encrypt(
    keyName: string,
    plaintextBase64: string,
    context?: Record<string, string>,
  ): Promise<TransitEncryptResult> {
    const res = await this.request<{ data: { ciphertext: string } }>(
      "POST",
      `${this.mount}/encrypt/${encodeURIComponent(keyName)}`,
      {
        plaintext: plaintextBase64,
        ...(context ? { context: base64EncodeJson(context) } : {}),
      },
    );
    return { ciphertext: res.data.ciphertext };
  }

  async decrypt(
    keyName: string,
    ciphertext: string,
    context?: Record<string, string>,
  ): Promise<TransitDecryptResult> {
    const res = await this.request<{ data: { plaintext: string } }>(
      "POST",
      `${this.mount}/decrypt/${encodeURIComponent(keyName)}`,
      {
        ciphertext,
        ...(context ? { context: base64EncodeJson(context) } : {}),
      },
    );
    return { plaintext: res.data.plaintext };
  }

  async generateDataKey(keyName: string): Promise<TransitDataKeyResult> {
    const res = await this.request<{ data: { plaintext: string; ciphertext: string } }>(
      "POST",
      `${this.mount}/datakey/plaintext/${encodeURIComponent(keyName)}`,
      { bits: 256 },
    );
    return { plaintext: res.data.plaintext, ciphertext: res.data.ciphertext };
  }

  async allowKeyDeletion(keyName: string): Promise<void> {
    await this.request("POST", `${this.mount}/keys/${encodeURIComponent(keyName)}/config`, {
      deletion_allowed: true,
    });
  }

  async deleteKey(keyName: string): Promise<void> {
    await this.request("DELETE", `${this.mount}/keys/${encodeURIComponent(keyName)}`);
  }

  async initStatus(): Promise<{ initialized: boolean }> {
    return this.request("GET", "sys/init");
  }

  async init(secretShares: number, secretThreshold: number): Promise<VaultInitResult> {
    const res = await this.request<{ keys: string[]; root_token: string }>(
      "PUT",
      "sys/init",
      { secret_shares: secretShares, secret_threshold: secretThreshold },
    );
    return { rootToken: res.root_token, keyShares: res.keys };
  }

  async sealStatus(): Promise<VaultSealStatus> {
    const res = await this.request<{ sealed: boolean; t: number; n: number; progress: number }>(
      "GET",
      "sys/seal-status",
    );
    return { sealed: res.sealed, t: res.t, n: res.n, progress: res.progress };
  }
}

function base64EncodeJson(obj: Record<string, string>): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}
