import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, withSessionContext } from "../src/migrate.js";

/**
 * Runs the real migrations 001-004 against a real Postgres instance and
 * verifies the actual behavior the blueprint's test gates call for: seed
 * row counts, the separation-of-duties trigger, locker_app's missing DELETE
 * grant, and RLS actually scoping what a session can see.
 *
 * Requires DATABASE_URL to point at a disposable Postgres database — this
 * test creates real tables and roles in it. Not run by the default `test`
 * script (see package.json's `test` vs `test:integration`), same pattern
 * as packages/kms and packages/mtls.
 */
const connectionString = process.env["DATABASE_URL"];
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb("packages/db schema (integration)", () => {
  let adminPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString });
    const migrationsDir = join(import.meta.dirname, "..", "migrations");
    await runMigrations(adminPool, migrationsDir);

    // Test-only: give locker_app a password so this suite can connect as
    // it. Migration 003 deliberately never sets one — see its comment.
    await adminPool.query("ALTER ROLE locker_app WITH PASSWORD 'test_only_password'");

    const url = new URL(connectionString as string);
    url.username = "locker_app";
    url.password = "test_only_password";
    appPool = new Pool({ connectionString: url.toString() });
  });

  afterAll(async () => {
    await adminPool.end();
    await appPool.end();
  });

  it("seeds exactly the 6 agencies from AGENCY_REGISTRY", async () => {
    const { rows } = await adminPool.query("SELECT code FROM agencies ORDER BY code");
    expect(rows.map((r) => r.code)).toEqual(["LBR", "LLA", "LNP", "LRA", "MOT", "NIR"]);
  });

  it("seeds exactly the 5 roles", async () => {
    const { rows } = await adminPool.query("SELECT role FROM roles ORDER BY role");
    expect(rows.map((r) => r.role)).toEqual(["AGENCY_SUPERVISOR", "APPROVER", "AUDITOR", "ISSUER", "PLATFORM_ADMIN"]);
  });

  it("seeds all 10 document types with exactly 6 flagged is_phase1", async () => {
    const { rows } = await adminPool.query("SELECT type, is_phase1 FROM document_types ORDER BY type");
    expect(rows).toHaveLength(10);
    const phase1 = rows.filter((r) => r.is_phase1).map((r) => r.type).sort();
    expect(phase1).toEqual(
      ["BUSINESS_LICENSE", "DRIVERS_LICENSE", "NATIONAL_ID", "TAX_CERTIFICATE", "TRAFFIC_TICKET", "VEHICLE_REGISTRATION"].sort(),
    );
  });

  it("flags exactly the 3 placeholder-agency document types", async () => {
    const { rows } = await adminPool.query(
      "SELECT type FROM document_types WHERE issuing_agency_is_placeholder ORDER BY type",
    );
    expect(rows.map((r) => r.type)).toEqual(["BIRTH_CERT", "EDUCATION_RECORD", "HEALTH_RECORD"]);
  });

  it("rejects a role grant that violates separation of duties", async () => {
    const [nir] = (await adminPool.query("SELECT id FROM agencies WHERE code = 'NIR'")).rows;
    const admin = (
      await adminPool.query(
        "INSERT INTO users (user_type, full_name) VALUES ('PLATFORM_ADMIN', 'Test Admin') RETURNING id",
      )
    ).rows[0];
    const staff = (
      await adminPool.query(
        "INSERT INTO users (user_type, full_name, agency_id) VALUES ('AGENCY_STAFF', 'Test Staff', $1) RETURNING id",
        [nir.id],
      )
    ).rows[0];

    await adminPool.query("INSERT INTO user_roles (user_id, role, agency_id, granted_by) VALUES ($1, 'ISSUER', $2, $3)", [
      staff.id,
      nir.id,
      admin.id,
    ]);

    await expect(
      adminPool.query("INSERT INTO user_roles (user_id, role, agency_id, granted_by) VALUES ($1, 'APPROVER', $2, $3)", [
        staff.id,
        nir.id,
        admin.id,
      ]),
    ).rejects.toThrow(/separation-of-duties violation/);
  });

  it("locker_app has no DELETE privilege on any seeded table", async () => {
    await expect(appPool.query("DELETE FROM agencies WHERE code = 'NIR'")).rejects.toThrow(/permission denied/);
    await expect(appPool.query("DELETE FROM document_types WHERE type = 'NATIONAL_ID'")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("RLS restricts a citizen session to their own users row", async () => {
    const citizen = (
      await adminPool.query("INSERT INTO users (user_type, full_name) VALUES ('CITIZEN', 'Test Citizen') RETURNING id")
    ).rows[0];
    const otherCitizen = (
      await adminPool.query("INSERT INTO users (user_type, full_name) VALUES ('CITIZEN', 'Other Citizen') RETURNING id")
    ).rows[0];

    const rows = await withSessionContext(
      appPool,
      { userId: citizen.id, userType: "CITIZEN", agencyId: null },
      async (client) => (await client.query("SELECT id FROM users")).rows,
    );

    const ids = rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(citizen.id);
    expect(ids).not.toContain(otherCitizen.id);
  });

  it("RLS grants platform_admin visibility into every users row", async () => {
    const rows = await withSessionContext(
      appPool,
      { userId: null, userType: "PLATFORM_ADMIN", agencyId: null },
      async (client) => (await client.query("SELECT id FROM users")).rows,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------
  // 005_citizen_self_registration.sql
  // ---------------------------------------------------------------------

  it("blocks a direct INSERT into users by locker_app with no session context", async () => {
    await expect(
      appPool.query("INSERT INTO users (user_type, full_name) VALUES ('CITIZEN', 'Direct Insert Attempt')"),
    ).rejects.toThrow(/row-level security policy/);
  });

  it("register_citizen succeeds via locker_app with no session context at all", async () => {
    const { rows } = await appPool.query(
      "SELECT register_citizen('Amara Kollie', NULL, '+231770123456') AS id",
    );
    expect(rows[0].id).toBeTruthy();

    const inserted = await adminPool.query("SELECT user_type, full_name FROM users WHERE id = $1", [rows[0].id]);
    expect(inserted.rows[0]).toEqual({ user_type: "CITIZEN", full_name: "Amara Kollie" });
  });

  it("register_citizen rejects a blank full_name", async () => {
    await expect(appPool.query("SELECT register_citizen('   ', NULL, NULL)")).rejects.toThrow(
      /full_name is required/,
    );
  });

  // ---------------------------------------------------------------------
  // 006_role_revocation.sql
  // ---------------------------------------------------------------------

  it("a revoked role no longer counts as a separation-of-duties conflict", async () => {
    const [nir] = (await adminPool.query("SELECT id FROM agencies WHERE code = 'NIR'")).rows;
    const admin = (
      await adminPool.query(
        "INSERT INTO users (user_type, full_name) VALUES ('PLATFORM_ADMIN', 'Revocation Test Admin') RETURNING id",
      )
    ).rows[0];
    const staff = (
      await adminPool.query(
        "INSERT INTO users (user_type, full_name, agency_id) VALUES ('AGENCY_STAFF', 'Revocation Test Staff', $1) RETURNING id",
        [nir.id],
      )
    ).rows[0];

    const grant = (
      await adminPool.query(
        "INSERT INTO user_roles (user_id, role, agency_id, granted_by) VALUES ($1, 'ISSUER', $2, $3) RETURNING id",
        [staff.id, nir.id, admin.id],
      )
    ).rows[0];

    // Still active: a conflicting APPROVER grant is rejected, same as before 006.
    await expect(
      adminPool.query("INSERT INTO user_roles (user_id, role, agency_id, granted_by) VALUES ($1, 'APPROVER', $2, $3)", [
        staff.id,
        nir.id,
        admin.id,
      ]),
    ).rejects.toThrow(/separation-of-duties violation/);

    await adminPool.query("UPDATE user_roles SET revoked_at = now(), revoked_by = $1 WHERE id = $2", [
      admin.id,
      grant.id,
    ]);

    // Now that the ISSUER grant is revoked, APPROVER should succeed.
    await expect(
      adminPool.query("INSERT INTO user_roles (user_id, role, agency_id, granted_by) VALUES ($1, 'APPROVER', $2, $3)", [
        staff.id,
        nir.id,
        admin.id,
      ]),
    ).resolves.toBeTruthy();
  });

  it("rejects rewriting user_id/role/agency_id on a user_roles row via UPDATE", async () => {
    const [nir] = (await adminPool.query("SELECT id FROM agencies WHERE code = 'NIR'")).rows;
    const admin = (
      await adminPool.query(
        "INSERT INTO users (user_type, full_name) VALUES ('PLATFORM_ADMIN', 'Immutability Test Admin') RETURNING id",
      )
    ).rows[0];
    const staff = (
      await adminPool.query(
        "INSERT INTO users (user_type, full_name, agency_id) VALUES ('AGENCY_STAFF', 'Immutability Test Staff', $1) RETURNING id",
        [nir.id],
      )
    ).rows[0];
    const grant = (
      await adminPool.query(
        "INSERT INTO user_roles (user_id, role, agency_id, granted_by) VALUES ($1, 'AUDITOR', $2, $3) RETURNING id",
        [staff.id, nir.id, admin.id],
      )
    ).rows[0];

    await expect(adminPool.query("UPDATE user_roles SET user_id = $1 WHERE id = $2", [admin.id, grant.id])).rejects.toThrow(
      /append-only except for revocation/,
    );

    // The one legitimate UPDATE shape — revocation only — must still succeed.
    await expect(
      adminPool.query("UPDATE user_roles SET revoked_at = now(), revoked_by = $1 WHERE id = $2", [admin.id, grant.id]),
    ).resolves.toBeTruthy();
  });

  it("locker_app still has no DELETE on user_roles after 006", async () => {
    await expect(appPool.query("DELETE FROM user_roles WHERE id = gen_random_uuid()")).rejects.toThrow(
      /permission denied/,
    );
  });
});
