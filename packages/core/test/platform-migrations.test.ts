import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openSqlDriver, type SqlDriver } from "../src/index-store/driver.js";
import { openIndexDatabase } from "../src/index-store/index-store.js";
import { migratePlatform, PLATFORM_MIGRATIONS, type PlatformMigration } from "../src/platform/migrations.js";

/** PostgreSQL runs too when a server is given, e.g. TACET_TEST_POSTGRES_URL=postgres://tacet:tacet@localhost:55432/tacet */
const postgresUrl = process.env.TACET_TEST_POSTGRES_URL;
const schema = `tacet_platform_test_${process.pid}_${Date.now()}`;
let run = 0;

const backends: Array<{ name: string; location: (dir: string) => string }> = [
  { name: "SQLite", location: (dir) => join(dir, `index-${++run}.db`) },
  ...(postgresUrl
    ? [{ name: "PostgreSQL", location: () => `${postgresUrl}${postgresUrl.includes("?") ? "&" : "?"}schema=${schema}_${++run}` }]
    : []),
];

afterAll(async () => {
  if (!postgresUrl) return;
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  for (let i = 1; i <= run; i++) await client.query(`DROP SCHEMA IF EXISTS ${schema}_${i} CASCADE`);
  await client.end();
});

describe.each(backends)("platform migrations on $name", ({ location }) => {
  let dir: string;
  let where: string;
  let driver: SqlDriver;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tacet-platform-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(async () => {
    where = location(dir);
    driver = await openSqlDriver(where);
  });
  afterEach(async () => {
    await driver.close();
  });

  const user = (id: string, email: string) =>
    driver.run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', '2026-10-14T00:00:00Z')", [id, email]);

  it("applies every migration once", async () => {
    const latest = PLATFORM_MIGRATIONS.at(-1)!.version;
    expect(await migratePlatform(driver)).toEqual({ applied: PLATFORM_MIGRATIONS.map((m) => m.version), version: latest });
    expect(await migratePlatform(driver)).toEqual({ applied: [], version: latest });
  });

  it("serializes concurrent runs", async () => {
    const results = await Promise.all([migratePlatform(driver), migratePlatform(driver)]);
    expect(results.flatMap((r) => r.applied)).toEqual(PLATFORM_MIGRATIONS.map((m) => m.version));
  });

  it("enforces uniqueness, roles and cascades", async () => {
    await migratePlatform(driver);
    await user("u1", "a@example.com");
    await expect(user("u2", "a@example.com")).rejects.toThrow();
    await driver.run("INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES ('w1', 'acme', 'Acme', 'u1', 'now')");
    await driver.run("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('w1', 'u1', 'owner', 'now')");
    await expect(
      driver.run("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('w1', 'u1', 'root', 'now')"),
    ).rejects.toThrow();
    await driver.run("INSERT INTO workspace_projects (id, workspace_id, slug, name, index_key, created_at) VALUES ('p1', 'w1', 'web', 'Web', 'p-1', 'now')");
    await expect(
      driver.run("INSERT INTO workspace_projects (id, workspace_id, slug, name, index_key, created_at) VALUES ('p2', 'w1', 'web', 'Web 2', 'p-2', 'now')"),
    ).rejects.toThrow();

    await driver.run("INSERT INTO workspace_slug_aliases (slug, workspace_id, created_at) VALUES ('old-acme', 'w1', 'now')");
    await expect(driver.run("INSERT INTO workspace_slug_aliases (slug, workspace_id, created_at) VALUES ('old-acme', 'w1', 'now')")).rejects.toThrow();

    await driver.run("DELETE FROM workspaces WHERE id = 'w1'");
    expect(await driver.all("SELECT * FROM workspace_members")).toEqual([]);
    expect(await driver.all("SELECT * FROM workspace_projects")).toEqual([]);
    expect(await driver.all("SELECT * FROM workspace_slug_aliases")).toEqual([]);
  });

  it("upgrades a database at migration 1 without touching its rows", async () => {
    expect(await migratePlatform(driver, PLATFORM_MIGRATIONS.slice(0, 1))).toEqual({ applied: [1], version: 1 });
    await user("u1", "a@example.com");
    expect(await migratePlatform(driver)).toEqual({ applied: [2], version: 2 });
    expect(await driver.all("SELECT id FROM users")).toEqual([{ id: "u1" }]);
    expect(await driver.all("SELECT * FROM workspace_slug_aliases")).toEqual([]);
  });

  it("keeps accounts when the index is rebuilt for a new layout", async () => {
    await migratePlatform(driver);
    await user("u1", "a@example.com");
    // Pretend the index was written by an older layout, so opening it drops and recreates the index tables.
    await (await openIndexDatabase(where)).close();
    await driver.run("UPDATE index_meta SET value = '0' WHERE key = 'schemaVersion'");
    await (await openIndexDatabase(where)).close();
    expect(await driver.all("SELECT id FROM users")).toEqual([{ id: "u1" }]);
  });

  it("refuses a database migrated by a newer version", async () => {
    const future: PlatformMigration = { version: 99, name: "future", sql: () => "SELECT 1" };
    await migratePlatform(driver, [...PLATFORM_MIGRATIONS, future]);
    await expect(migratePlatform(driver)).rejects.toThrow(/99/);
  });
});
