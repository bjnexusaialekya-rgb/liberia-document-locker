/**
 * vault-unseal-handover.ts — the production key-custody handover mechanism
 * named in the master blueprint (RFP #11):
 *
 *   "Key custody: BJNEXUS holds Vault root/unseal authority during
 *   build/demo phase (client-confirmed for now); planned handover
 *   mechanism at production launch is Shamir's Secret Sharing — split the
 *   unseal key into shares (e.g. 5 shares, 3-of-5 to unseal), redistribute
 *   shares to named government officials at launch, provably destroy
 *   BJNEXUS's shares. This is a direct, deliberate mitigation for the
 *   exact failure mode that already happened to NIR (Techno Brain holding
 *   effective control of the database, locking government out after a
 *   payment dispute)."
 *
 * NOT invoked automatically anywhere in this package or at build/demo-time
 * startup — this only runs once, deliberately, at production launch. Vault
 * dev-mode (used for local/staging per docker-compose.vault.yml) is never
 * sealed and does not go through this path at all; this module targets a
 * real, non-dev Vault cluster.
 *
 * IMPORTANT — how this differs from shamir.ts: this module does NOT
 * reimplement Shamir's math. Vault's own `PUT sys/init` already splits its
 * root/unseal material via real SSS internally; this module drives that
 * real API and adds the operational pieces the blueprint asks for on top
 * (custody bookkeeping + provable destruction of BJNEXUS's copies).
 * shamir.ts exists as a separately testable, standalone implementation of
 * the same algorithm — see its module docstring for why both exist.
 */

import { randomBytes } from "node:crypto";
import { unlink, open, stat } from "node:fs/promises";
import type { IVaultClient, VaultInitResult } from "./vault-client";
import { KmsError } from "./errors";
import type { AuditLogWriter } from "./types";

export interface HandoverPlan {
  /** Total number of shares to generate. Blueprint default: 5. */
  totalShares: number;
  /** Shares required to unseal. Blueprint default: 3 (3-of-5). */
  threshold: number;
  /** Named custodians shares will be redistributed to — for the audit record, not enforced by this module. */
  custodians: string[];
}

export interface ShareCustodyRecord {
  shareIndex: number; // 1-based position among the returned key shares
  custodianName: string;
  /** Filesystem path (or other reference) where BJNEXUS's temporary local copy of this share was written, if any. */
  bjnexusLocalCopyPath: string | null;
  redistributedAt: string | null;
  bjnexusCopyDestroyedAt: string | null;
}

export interface HandoverResult {
  rootToken: string;
  custody: ShareCustodyRecord[];
}

export class VaultInitAlreadyDoneError extends KmsError {
  constructor() {
    super("Vault reports it is already initialized. Handover init must only run once, against a fresh cluster.");
  }
}

/**
 * Step 1 — SPLIT: initializes a fresh, never-before-initialized Vault
 * cluster, which internally performs real Shamir sharing of the root key
 * material into `plan.totalShares` shares requiring `plan.threshold` to
 * unseal. Refuses to run against an already-initialized Vault so this can
 * never be accidentally re-run against production.
 */
export async function initializeWithShamirSharing(
  vault: IVaultClient,
  plan: HandoverPlan,
): Promise<VaultInitResult> {
  if (plan.custodians.length !== plan.totalShares) {
    throw new KmsError(
      `custodians list has ${plan.custodians.length} entries but totalShares is ${plan.totalShares} — provide exactly one named custodian per share.`,
    );
  }
  const status = await vault.initStatus();
  if (status.initialized) throw new VaultInitAlreadyDoneError();

  return vault.init(plan.totalShares, plan.threshold);
}

/**
 * Step 2 — REDISTRIBUTE (bookkeeping only): this module does not transmit
 * shares anywhere — real-world redistribution to named officials happens
 * out-of-band (in person, sealed envelope, hardware token — a process
 * decision for the client, not code). What this function does is produce
 * the custody ledger entry proving *who* each share index was assigned to
 * and *when*, which the audit-log entry below makes tamper-evident.
 */
export function buildCustodyRecords(
  init: VaultInitResult,
  plan: HandoverPlan,
  localCopyPaths: (string | null)[],
): ShareCustodyRecord[] {
  if (localCopyPaths.length !== init.keyShares.length) {
    throw new KmsError("localCopyPaths must have one entry (or null) per key share");
  }
  const now = new Date().toISOString();
  return init.keyShares.map((_share, i) => ({
    shareIndex: i + 1,
    custodianName: plan.custodians[i] as string,
    bjnexusLocalCopyPath: localCopyPaths[i] ?? null,
    redistributedAt: now,
    bjnexusCopyDestroyedAt: null,
  }));
}

/**
 * Step 3 — PROVABLY DESTROY: securely erases BJNEXUS's local copies of the
 * unseal shares after redistribution is confirmed. "Provably" here means:
 * multi-pass overwrite with cryptographically random data before unlink
 * (defends against filesystem-level recovery of the raw bytes on
 * traditional storage; note this is best-effort on SSDs/copy-on-write
 * filesystems due to wear-leveling and snapshots — call this out
 * explicitly to the client rather than overclaiming), plus a signed
 * audit-log entry recording exactly which share indices were destroyed and
 * when, which is the actual durable proof for an external auditor.
 *
 * Files that don't exist are treated as already-destroyed (idempotent).
 */
export async function destroyBjnexusLocalShares(
  records: ShareCustodyRecord[],
  auditLog: AuditLogWriter,
  actor: { actorId: string; agencyId: string | null },
): Promise<ShareCustodyRecord[]> {
  const destroyedAt = new Date().toISOString();
  const results: ShareCustodyRecord[] = [];

  for (const record of records) {
    if (record.bjnexusLocalCopyPath) {
      await secureOverwriteAndUnlink(record.bjnexusLocalCopyPath);
    }
    results.push({ ...record, bjnexusCopyDestroyedAt: destroyedAt });
  }

  await auditLog.write({
    eventType: "kms.key_destroyed_erasure_request", // see README: shared-types has no dedicated unseal-handover event type yet — flagged as a follow-up, this is the closest existing type and is explicit in metadata below.
    actorId: actor.actorId,
    actorType: "SERVICE",
    agencyId: actor.agencyId,
    resourceType: "vault_unseal_share",
    resourceId: "bjnexus_local_copies",
    metadata: {
      note: "Production launch: BJNEXUS unseal-share handover destruction, not a citizen erasure request.",
      shareIndicesDestroyed: results.map((r) => r.shareIndex),
      custodians: results.map((r) => r.custodianName),
      destroyedAt,
    },
  });

  return results;
}

async function secureOverwriteAndUnlink(path: string, passes = 3): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    if (isEnoent(err)) return; // already gone — idempotent
    throw err;
  }

  const handle = await open(path, "r+");
  try {
    for (let pass = 0; pass < passes; pass++) {
      await handle.write(randomBytes(size), 0, size, 0);
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
  await unlink(path);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
