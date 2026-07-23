import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

export interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

/** Reads every *.sql file in `dir`, sorted lexically (001_ before 002_, etc). */
export function loadMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(dir, filename), "utf8");
      return { filename, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

interface AppliedRecord {
  filename: string;
  checksum: string;
}

/**
 * Looks up already-applied migrations. Returns an empty array (not an
 * error) if schema_migrations doesn't exist yet — that's the expected state
 * before 001_extensions.sql (which creates that table) has run.
 */
async function getAppliedMigrations(client: PoolClient): Promise<AppliedRecord[]> {
  try {
    const result = await client.query<AppliedRecord>(
      "SELECT filename, checksum FROM schema_migrations ORDER BY filename",
    );
    return result.rows;
  } catch (err) {
    if (isUndefinedTableError(err)) return [];
    throw err;
  }
}

function isUndefinedTableError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "42P01";
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies every migration in `dir` that hasn't already run, in filename
 * order, each inside its own transaction. Safe to call repeatedly — already
 * applied migrations are skipped, not re-run. If a previously applied
 * migration's file content no longer matches its recorded checksum, this
 * throws rather than silently re-running or skipping it: a changed
 * already-applied migration means either the file was edited after the fact
 * (never do this — write a new migration instead) or you're pointed at the
 * wrong migrations directory.
 */
export async function runMigrations(pool: Pool, dir: string): Promise<RunMigrationsResult> {
  const migrations = loadMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  try {
    const appliedRecords = new Map((await getAppliedMigrations(client)).map((r) => [r.filename, r.checksum]));

    for (const migration of migrations) {
      const existingChecksum = appliedRecords.get(migration.filename);

      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.filename} has already been applied with a different checksum. ` +
              `Never edit an applied migration — write a new one instead.`,
          );
        }
        alreadyApplied.push(migration.filename);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        // 001_extensions.sql creates schema_migrations as part of its own
        // body, so by the time we reach this INSERT (even for 001 itself)
        // the table already exists within the same transaction.
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING",
          [migration.filename, migration.checksum],
        );
        await client.query("COMMIT");
        applied.push(migration.filename);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${migration.filename} failed: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
    }
  } finally {
    client.release();
  }

  return { applied, alreadyApplied };
}

export interface SessionContext {
  userId: string | null;
  /** One of the 4 USER_TYPES from @liberia-locker/shared-types, or "SERVICE" for mTLS-authenticated service-to-service calls. */
  userType: string | null;
  agencyId: string | null;
}

/**
 * Sets the three RLS session-context GUCs (see migration 003) for the
 * duration of the current transaction via SET LOCAL, which is essential:
 * SET (without LOCAL) would persist on the pooled connection and leak into
 * whichever unrelated request borrows that connection next. Must be called
 * inside an already-open transaction on `client` — see withSessionContext
 * for the common case of "one transaction per request."
 */
export async function setSessionContext(client: PoolClient, ctx: SessionContext): Promise<void> {
  await client.query("SELECT set_config('app.current_user_id', $1, true)", [ctx.userId ?? ""]);
  await client.query("SELECT set_config('app.current_user_type', $1, true)", [ctx.userType ?? ""]);
  await client.query("SELECT set_config('app.current_agency_id', $1, true)", [ctx.agencyId ?? ""]);
}

/**
 * Runs `fn` inside a transaction with the given session context applied,
 * committing on success and rolling back on any thrown error. This is the
 * pattern every service should use for a single authenticated request:
 * one transaction, one set of session-context GUCs, RLS enforced throughout.
 */
export async function withSessionContext<T>(
  pool: Pool,
  ctx: SessionContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setSessionContext(client, ctx);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
