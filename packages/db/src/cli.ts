#!/usr/bin/env node
import { join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";

/**
 * Standalone migration-runner entrypoint (`npm run migrate`). Not imported
 * by any service — services import runMigrations()/withSessionContext()
 * directly from the package. This file exists purely so migrations can be
 * applied from CI or a Codespace shell without writing a one-off script.
 */
async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    console.error("DATABASE_URL environment variable is required.");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString });
  try {
    const migrationsDir = join(import.meta.dirname, "..", "migrations");
    const result = await runMigrations(pool, migrationsDir);
    console.log(`Applied: ${result.applied.length ? result.applied.join(", ") : "(none — nothing new)"}`);
    console.log(`Already applied: ${result.alreadyApplied.length ? result.alreadyApplied.join(", ") : "(none)"}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
