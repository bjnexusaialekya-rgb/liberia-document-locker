-- 001_extensions.sql
-- Enables the two Postgres extensions the rest of the schema depends on:
--   pgcrypto — gen_random_uuid() for every table's id column, plus digest()
--              used later by packages/audit-log's hash-chain verification.
--   citext   — case-insensitive text, used for email and national ID number
--              columns so "Alekya@x.com" and "alekya@x.com" collide correctly
--              instead of silently creating duplicate-looking rows.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Migration bookkeeping table. Every migration file after this one is
-- recorded here by src/migrate.ts after it applies successfully, keyed by
-- filename, so re-running the runner is a no-op for anything already
-- applied instead of re-executing (and erroring on) already-created objects.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
