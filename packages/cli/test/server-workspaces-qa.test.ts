import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratePlatform, openSqlDriver, PLATFORM_MIGRATIONS, PlatformAccounts } from "@tacet-api/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTacetApiServer, type TacetApiServer, type TacetApiServerOptions } from "../src/server.js";

/**
 * QA-0002 (TASK-0004): the HTTP-level gaps left after REVIEW-0002: the admin rank rule over HTTP, expired invites
 * (410, purged at restart), concurrent last-owner changes, slug aliases taken back and kept from others, slug races
 * answered 409 rather than 500, PATCH through CORS preflight, restarts and the upgrade from migration 1.
 */
const TOKEN = "machine-token";
const PASSWORD = "correct horse battery";

/** PostgreSQL runs too when a server is given, e.g. TACET_TEST_POSTGRES_URL=postgres://tacet:tacet@localhost:55432/tacet */
const postgresUrl = process.env.TACET_TEST_POSTGRES_URL;
const schema = `tacet_workspaces_qa_test_${process.pid}_${Date.now()}`;
let run = 0;
const backends = [
  { name: "SQLite", location: (dir: string) => join(dir, `index-${++run}.db`) },
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

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

describe.each(backends)("QA-0002 workspaces over HTTP on $name", ({ location }) => {
  let dir: string;
  const servers: TacetApiServer[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tacet-workspaces-qa-"));
  });
  afterAll(async () => {
    for (const api of servers) await api.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async (index = location(dir), options: TacetApiServerOptions = {}) => {
    const api = await createTacetApiServer({ index, token: TOKEN, accounts: true, ...options });
    servers.push(api);
    const base = await api.listen(0);
    const call = async (method: string, path: string, body?: unknown, token?: string | null, headers: Record<string, string> = {}): Promise<Reply> => {
      const res = await fetch(`${base}${path}`, {
        method,
        redirect: "manual",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    };
    const user = async (email: string) => {
      const { body } = await call("POST", "/auth/signup", { email, password: PASSWORD });
      return { id: body.user.id as string, email, token: body.token as string };
    };
    type User = Awaited<ReturnType<typeof user>>;
    /** Invites `who` with `role` as `by` and accepts as `who`. */
    const join_ = async (ws: string, by: User, who: User, role: string) => {
      const invite = await call("POST", `/workspaces/${ws}/invites`, { email: who.email, role }, by.token);
      expect((await call("POST", "/invites/accept", { token: invite.body.token }, who.token)).status).toBe(200);
    };
    const stop = async () => {
      servers.splice(servers.indexOf(api), 1);
      await api.close();
    };
    return { api, call, user, join: join_, stop, index };
  };

  it("holds an admin to roles below their own over HTTP (Operator decision OQ-1)", async () => {
    const { call, user, join } = await start();
    const owner = await user("owner@example.com");
    const admin = await user("admin@example.com");
    const admin2 = await user("admin2@example.com");
    const member = await user("member@example.com");
    await call("POST", "/workspaces", { name: "Team", slug: "team" }, owner.token);
    await join("team", owner, admin, "admin");
    await join("team", owner, admin2, "admin");
    await join("team", owner, member, "member");
    const role = (who: { id: string }, value: string) => call("PATCH", `/workspaces/team/members/${who.id}`, { role: value }, admin.token);

    expect((await role(member, "viewer")).status).toBe(200);
    expect((await role(member, "member")).status).toBe(200);
    expect((await role(member, "admin")).status).toBe(403);
    expect((await role(member, "owner")).status).toBe(403);
    expect((await role(admin2, "member")).status).toBe(403);
    expect((await role(owner, "member")).status).toBe(403);
    expect((await role(admin, "member")).status).toBe(403);
    expect((await call("DELETE", `/workspaces/team/members/${admin2.id}`, undefined, admin.token)).status).toBe(403);
    expect((await call("DELETE", `/workspaces/team/members/${owner.id}`, undefined, admin.token)).status).toBe(403);
    for (const [invited, status] of [["owner", 403], ["admin", 403], ["member", 200], ["viewer", 200]] as const) {
      expect((await call("POST", "/workspaces/team/invites", { email: `${invited}-x@example.com`, role: invited }, admin.token)).status).toBe(status);
    }
    expect((await call("POST", "/workspaces/team/transfer", { userId: member.id }, admin.token)).status).toBe(403);
    expect((await call("DELETE", "/workspaces/team", undefined, admin.token)).status).toBe(403);
    expect((await call("GET", "/workspaces/team/members", undefined, owner.token)).body.map((m: { role: string }) => m.role).sort()).toEqual([
      "admin",
      "admin",
      "member",
      "owner",
    ]);
  });

  it("keeps exactly one owner when two owners demote, remove or leave each other at once", async () => {
    const { call, user, join } = await start();
    const a = await user("a@example.com");
    const b = await user("b@example.com");
    const moves = [
      (ws: string) => [
        call("PATCH", `/workspaces/${ws}/members/${b.id}`, { role: "admin" }, a.token),
        call("PATCH", `/workspaces/${ws}/members/${a.id}`, { role: "admin" }, b.token),
      ],
      (ws: string) => [call("POST", `/workspaces/${ws}/leave`, undefined, a.token), call("POST", `/workspaces/${ws}/leave`, undefined, b.token)],
      (ws: string) => [
        call("DELETE", `/workspaces/${ws}/members/${b.id}`, undefined, a.token),
        call("DELETE", `/workspaces/${ws}/members/${a.id}`, undefined, b.token),
      ],
    ];
    for (const [i, move] of moves.entries()) {
      const ws = `pair-${i}`;
      await call("POST", "/workspaces", { name: ws, slug: ws }, a.token);
      await join(ws, a, b, "owner");
      const statuses = (await Promise.all(move(ws))).map((r) => r.status).sort();
      // The loser re-reads its role under the lock: already demoted (403), removed (404) or the last owner (409).
      expect(statuses[0]).toBe(200);
      expect([403, 404, 409]).toContain(statuses[1]);
      const survivor = (await call("GET", "/workspaces", undefined, a.token)).body.some((w: { slug: string }) => w.slug === ws) ? a : b;
      const members = (await call("GET", `/workspaces/${ws}/members`, undefined, survivor.token)).body;
      expect(members.filter((m: { role: string }) => m.role === "owner")).toHaveLength(1);
    }
  });

  it("answers an expired invite 410, and purges it when the server starts again", async () => {
    const first = await start();
    const owner = await first.user("owner@example.com");
    const guest = await first.user("guest@example.com");
    await first.call("POST", "/workspaces", { name: "Team", slug: "team" }, owner.token);
    const expired = await first.call("POST", "/workspaces/team/invites", { email: "late@example.com", role: "member" }, owner.token);
    const pending = await first.call("POST", "/workspaces/team/invites", { email: "soon@example.com", role: "viewer" }, owner.token);
    const db = await openSqlDriver(first.index);
    await db.run("UPDATE workspace_invites SET expires_at = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), expired.body.id]);
    await db.close();

    expect((await first.call("POST", "/invites/accept", { token: expired.body.token }, guest.token)).status).toBe(410);
    expect((await first.call("GET", "/workspaces/team", undefined, guest.token)).status).toBe(404);
    expect((await first.call("GET", "/workspaces/team/invites", undefined, owner.token)).body.map((i: { id: string }) => i.id)).toContain(expired.body.id);
    await first.call("PATCH", "/workspaces/team", { slug: "team-new" }, owner.token);
    await first.stop();

    // Everything survives the restart but the expired invite.
    const second = await start(first.index);
    expect((await second.call("GET", "/me", undefined, owner.token)).body.workspaces).toBe(2);
    expect((await second.call("GET", "/workspaces/team-new/invites", undefined, owner.token)).body.map((i: { id: string }) => i.id)).toEqual([pending.body.id]);
    expect((await second.call("POST", "/invites/accept", { token: expired.body.token }, guest.token)).status).toBe(404);
    const old = await second.call("GET", "/workspaces/team/members", undefined, owner.token);
    expect([old.status, old.headers.get("location")]).toEqual([308, "/workspaces/team-new/members"]);
    expect((await second.call("POST", "/invites/accept", { token: pending.body.token }, guest.token)).body).toMatchObject({ slug: "team-new", role: "viewer" });
  });

  it("keeps a workspace's old slugs from everyone else, lets it take one back, and picks around them (REVIEW-0002 OQ-5)", async () => {
    const { call, user } = await start();
    const owner = await user("owner@example.com");
    const other = await user("other@example.com");
    await call("POST", "/workspaces", { name: "A", slug: "slug-a" }, owner.token);
    await call("PATCH", "/workspaces/slug-a", { slug: "slug-b" }, owner.token);
    await call("PATCH", "/workspaces/slug-b", { slug: "slug-c" }, owner.token);

    await call("POST", "/workspaces", { name: "Other", slug: "other-ws" }, other.token);
    for (const taken of ["slug-a", "slug-b", "slug-c"]) {
      expect((await call("PATCH", "/workspaces/other-ws", { slug: taken }, other.token)).status).toBe(409);
      expect((await call("POST", "/workspaces", { name: "x", slug: taken }, other.token)).status).toBe(409);
    }
    // A generated slug, and a personal workspace's, steer around an alias instead of failing.
    expect((await call("POST", "/workspaces", { name: "slug a" }, other.token)).body.slug).toMatch(/^slug-a-[0-9a-f]{4}$/);
    const namesake = await user("slug-b@example.com");
    expect((await call("GET", "/workspaces", undefined, namesake.token)).body[0].slug).toMatch(/^slug-b-[0-9a-f]{4}$/);

    expect((await call("PATCH", "/workspaces/slug-c", { slug: "slug-a" }, owner.token)).body).toMatchObject({ slug: "slug-a" });
    for (const old of ["slug-b", "slug-c"]) {
      const res = await call("GET", `/workspaces/${old}/invites?q=1`, undefined, owner.token);
      expect([res.status, res.headers.get("location")]).toEqual([308, "/workspaces/slug-a/invites?q=1"]);
    }
    expect((await call("GET", "/workspaces/slug-a", undefined, owner.token)).status).toBe(200);
    expect((await call("GET", "/workspaces/slug-c", undefined, other.token)).status).toBe(404);
  });

  it("answers slug races with 409 or a fresh slug, never 500 (REVIEW-0002 R4)", async () => {
    const { call, user } = await start();
    const dev = await user("dev@example.com");
    const chosen = (await Promise.all([1, 2, 3, 4, 5].map(() => call("POST", "/workspaces", { name: "Same", slug: "same" }, dev.token)))).map((r) => r.status);
    expect(chosen.sort()).toEqual([200, 409, 409, 409, 409]);
    const generated = await Promise.all([1, 2, 3, 4, 5].map(() => call("POST", "/workspaces", { name: "Generated" }, dev.token)));
    expect(generated.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(generated.map((r) => r.body.slug)).size).toBe(5);
    await call("POST", "/workspaces", { name: "One", slug: "one" }, dev.token);
    await call("POST", "/workspaces", { name: "Two", slug: "two" }, dev.token);
    const renames = await Promise.all(["one", "two"].map((ws) => call("PATCH", `/workspaces/${ws}`, { slug: "target" }, dev.token)));
    expect(renames.map((r) => r.status).sort()).toEqual([200, 409]);
    const signUps = await Promise.all([1, 2, 3, 4].map((i) => call("POST", "/auth/signup", { email: `twin@d${i}.example`, password: PASSWORD })));
    expect(signUps.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    for (const [slug, status] of [["ab", 400], ["abc", 200], ["a".repeat(40), 200], ["a".repeat(41), 400], ["-ab", 400], ["ab-", 400], ["a_b", 400]] as const) {
      expect((await call("POST", "/workspaces", { name: "n", slug }, dev.token)).status).toBe(status);
    }
  });

  it("lets a browser PATCH through the CORS preflight", async () => {
    const { call, user } = await start(undefined, { cors: "https://dash.example" });
    const dev = await user("dev@example.com");
    const preflight = await call("OPTIONS", "/workspaces/dev", undefined, null, {
      Origin: "https://dash.example",
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "authorization, content-type",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://dash.example");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PATCH");
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(/authorization/i);
    const patched = await call("PATCH", "/workspaces/dev", { name: "Renamed" }, dev.token, { Origin: "https://dash.example" });
    expect([patched.status, patched.body.name, patched.headers.get("access-control-allow-origin")]).toEqual([200, "Renamed", "https://dash.example"]);
  });

  it("upgrades a database at migration 1 to 2 when the server starts, keeping its users and workspaces", async () => {
    const index = location(dir);
    const db = await openSqlDriver(index);
    expect((await migratePlatform(db, [PLATFORM_MIGRATIONS[0]])).version).toBe(1);
    // Users from before workspaces existed: one given a workspace by hand, one with none.
    const accounts = new PlatformAccounts(db);
    const old = await accounts.signUp({ email: "old@example.com", password: PASSWORD });
    const none = await accounts.signUp({ email: "none@example.com", password: PASSWORD });
    const now = new Date().toISOString();
    await db.run("INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES (?, 'legacy', 'Legacy', ?, ?)", [
      "11111111-1111-4111-8111-111111111111",
      old.user.id,
      now,
    ]);
    await db.run("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [
      "11111111-1111-4111-8111-111111111111",
      old.user.id,
      now,
    ]);
    await db.close();

    const { call, index: same } = await start(index);
    const check = await openSqlDriver(same);
    const versions = await check.all<{ version: number | string; name: string }>("SELECT version, name FROM platform_migrations ORDER BY version");
    await check.close();
    expect(versions.map((v) => [Number(v.version), v.name])).toEqual([
      [1, "accounts-and-workspaces"],
      [2, "workspace-slug-aliases"],
    ]);
    expect((await call("GET", "/workspaces", undefined, old.token)).body).toEqual([expect.objectContaining({ slug: "legacy", role: "owner" })]);
    expect((await call("PATCH", "/workspaces/legacy", { slug: "legacy-2" }, old.token)).status).toBe(200);
    expect((await call("GET", "/workspaces/legacy", undefined, old.token)).status).toBe(308);
    expect((await call("GET", "/me", undefined, none.token)).body.workspaces).toBe(0);
    expect((await call("POST", "/workspaces", { name: "Mine" }, none.token)).body).toMatchObject({ slug: "mine", role: "owner" });
  });
});
