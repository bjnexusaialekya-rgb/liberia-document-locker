import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadMigrations, runMigrations } from "../src/migrate.js";

/**
 * Minimal fake Pool/PoolClient — enough of the `pg` surface for
 * runMigrations() to drive, without a real Postgres connection. Keeps an
 * in-memory `schema_migrations` table and a `queryLog` so tests can assert
 * on what actually got executed and in what order.
 */
class FakePool {
  public queryLog: string[] = [];
  private schemaMigrations: Array<{ filename: string; checksum: string }> = [];
  private schemaMigrationsTableExists = false;

  async connect() {
    return {
      query: async (sql: string, params?: unknown[]) => {
        this.queryLog.push(sql.trim().split("\n")[0] ?? sql);

        if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations") || sql.includes("CREATE TABLE schema_migrations")) {
          this.schemaMigrationsTableExists = true;
          return { rows: [] };
        }
        if (sql.startsWith("SELECT filename, checksum FROM schema_migrations")) {
          if (!this.schemaMigrationsTableExists) {
            const err = new Error('relation "schema_migrations" does not exist') as Error & { code: string };
            err.code = "42P01";
            throw err;
          }
          return { rows: this.schemaMigrations };
        }
        if (sql.startsWith("INSERT INTO schema_migrations")) {
          const [filename, checksum] = params as [string, string];
          if (!this.schemaMigrations.some((m) => m.filename === filename)) {
            this.schemaMigrations.push({ filename, checksum });
          }
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {
        /* no-op for the fake */
      },
    };
  }
}

describe("loadMigrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migrations-test-"));
    writeFileSync(join(dir, "002_second.sql"), "CREATE TABLE b (id int);");
    writeFileSync(join(dir, "001_first.sql"), "CREATE TABLE a (id int);");
    writeFileSync(join(dir, "not-a-migration.txt"), "ignore me");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns .sql files sorted lexically, ignoring non-.sql files", () => {
    const migrations = loadMigrations(dir);
    expect(migrations.map((m) => m.filename)).toEqual(["001_first.sql", "002_second.sql"]);
  });

  it("computes a stable sha256 checksum per file", () => {
    const [first] = loadMigrations(dir);
    expect(first?.checksum).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("runMigrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migrations-run-test-"));
    writeFileSync(
      join(dir, "001_extensions.sql"),
      "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now());",
    );
    writeFileSync(join(dir, "002_agencies.sql"), "CREATE TABLE agencies (id uuid PRIMARY KEY);");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies every migration in order on a fresh database", async () => {
    const pool = new FakePool();
    const result = await runMigrations(pool as never, dir);
    expect(result.applied).toEqual(["001_extensions.sql", "002_agencies.sql"]);
    expect(result.alreadyApplied).toEqual([]);
  });

  it("is idempotent: a second run applies nothing new", async () => {
    const pool = new FakePool();
    await runMigrations(pool as never, dir);
    const second = await runMigrations(pool as never, dir);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(["001_extensions.sql", "002_agencies.sql"]);
  });

  it("throws if an already-applied migration's content changed since it ran", async () => {
    const pool = new FakePool();
    await runMigrations(pool as never, dir);
    writeFileSync(join(dir, "001_extensions.sql"), "-- tampered with after the fact");

    await expect(runMigrations(pool as never, dir)).rejects.toThrow(/different checksum/);
  });

  it("applies only the new migration when one more file is added later", async () => {
    const pool = new FakePool();
    await runMigrations(pool as never, dir);
    writeFileSync(join(dir, "003_users.sql"), "CREATE TABLE users (id uuid PRIMARY KEY);");

    const result = await runMigrations(pool as never, dir);
    expect(result.applied).toEqual(["003_users.sql"]);
    expect(result.alreadyApplied).toEqual(["001_extensions.sql", "002_agencies.sql"]);
  });
});
