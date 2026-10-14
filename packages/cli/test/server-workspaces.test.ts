import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTacetApiServer, HttpError, matchRoute, type TacetApiServer } from "../src/server.js";

const TOKEN = "machine-token";
const PASSWORD = "correct horse battery";

/** PostgreSQL runs too when a server is given, e.g. TACET_TEST_POSTGRES_URL=postgres://tacet:tacet@localhost:55432/tacet */
const postgresUrl = process.env.TACET_TEST_POSTGRES_URL;
const schema = `tacet_workspaces_api_test_${process.pid}_${Date.now()}`;
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

describe.each(backends)("workspaces over HTTP on $name", ({ location }) => {
  let dir: string;
  const servers: TacetApiServer[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tacet-workspaces-api-"));
  });
  afterAll(async () => {
    for (const api of servers) await api.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async () => {
    const api = await createTacetApiServer({ index: location(dir), token: TOKEN, accounts: true });
    servers.push(api);
    const base = await api.listen(0);
    const call = async (method: string, path: string, body?: unknown, token?: string | null) => {
      const res = await fetch(`${base}${path}`, {
        method,
        redirect: "manual",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, location: res.headers.get("location") };
    };
    /** Signs up and returns the user and their session token. */
    const user = async (email: string) => {
      const { body } = await call("POST", "/auth/signup", { email, password: PASSWORD });
      return { id: body.user.id as string, email, token: body.token as string };
    };
    return { call, user, base };
  };

  it("lists the personal workspace made at sign-up and manages workspaces", async () => {
    const { call, user } = await start();
    const dev = await user("dev@example.com");
    expect((await call("GET", "/workspaces", undefined, dev.token)).body).toEqual([
      expect.objectContaining({ slug: "dev", name: "dev", role: "owner" }),
    ]);
    expect((await call("GET", "/workspaces")).status).toBe(401);
    expect((await call("GET", "/workspaces", undefined, TOKEN)).status).toBe(401);

    const created = await call("POST", "/workspaces", { name: "Acme", slug: "acme" }, dev.token);
    expect(created).toMatchObject({ status: 200, body: { slug: "acme", role: "owner" } });
    expect((await call("POST", "/workspaces", { name: "Acme", slug: "acme" }, dev.token)).status).toBe(409);
    expect((await call("POST", "/workspaces", { name: "Bad", slug: "Not_OK" }, dev.token)).status).toBe(400);
    expect((await call("POST", "/workspaces", {}, dev.token)).status).toBe(400);

    expect((await call("PATCH", "/workspaces/acme", { name: "Acme Inc", slug: "acme-inc" }, dev.token)).body).toMatchObject({
      slug: "acme-inc",
      name: "Acme Inc",
    });
    expect((await call("GET", "/workspaces/acme-inc", undefined, dev.token)).status).toBe(200);
    expect((await call("GET", "/workspaces/acme", undefined, dev.token)).status).toBe(308);
    expect((await call("GET", "/workspaces/NOT%20A%20SLUG", undefined, dev.token)).status).toBe(400);
    expect((await call("DELETE", "/workspaces/acme-inc", undefined, dev.token)).body).toEqual({ ok: true });
    expect((await call("GET", "/workspaces/acme-inc", undefined, dev.token)).status).toBe(404);
  });

  it("answers non-members 404 and members without the role 403", async () => {
    const { call, user } = await start();
    const owner = await user("owner@example.com");
    const viewer = await user("viewer@example.com");
    const stranger = await user("stranger@example.com");
    await call("POST", "/workspaces", { name: "Team", slug: "team" }, owner.token);
    const invite = await call("POST", "/workspaces/team/invites", { email: viewer.email, role: "viewer" }, owner.token);
    await call("POST", "/invites/accept", { token: invite.body.token }, viewer.token);

    for (const [method, path, body] of [
      ["GET", "/workspaces/team"],
      ["GET", "/workspaces/team/members"],
      ["PATCH", "/workspaces/team", { name: "Mine" }],
      ["DELETE", "/workspaces/team"],
      ["POST", "/workspaces/team/invites", { email: "x@example.com", role: "viewer" }],
      ["DELETE", `/workspaces/team/members/${viewer.id}`],
    ] as const) {
      expect((await call(method, path, body, stranger.token)).status, `${method} ${path}`).toBe(404);
    }
    expect((await call("GET", "/workspaces/team/members", undefined, viewer.token)).body).toHaveLength(2);
    expect((await call("GET", "/workspaces/team/invites", undefined, viewer.token)).status).toBe(403);
    expect((await call("POST", "/workspaces/team/invites", { email: "x@example.com", role: "viewer" }, viewer.token)).status).toBe(403);
    expect((await call("DELETE", "/workspaces/team", undefined, viewer.token)).status).toBe(403);
  });

  it("changes roles and removes members, keeping the last owner", async () => {
    const { call, user } = await start();
    const owner = await user("owner@example.com");
    const admin = await user("admin@example.com");
    await call("POST", "/workspaces", { name: "Team", slug: "team" }, owner.token);
    const invite = await call("POST", "/workspaces/team/invites", { email: admin.email, role: "admin" }, owner.token);
    expect((await call("POST", "/invites/accept", { token: invite.body.token }, admin.token)).body).toMatchObject({ slug: "team", role: "admin" });

    const role = (who: string, value: string, as: string) => call("PATCH", `/workspaces/team/members/${who}`, { role: value }, as);
    expect((await role(owner.id, "admin", owner.token)).status).toBe(409);
    expect((await role(owner.id, "member", admin.token)).status).toBe(403);
    expect((await role(admin.id, "boss", owner.token)).status).toBe(400);
    expect((await role("not-a-uuid", "member", owner.token)).status).toBe(400);
    expect((await call("POST", "/workspaces/team/leave", undefined, owner.token)).status).toBe(409);
    expect((await call("DELETE", `/workspaces/team/members/${owner.id}`, undefined, owner.token)).status).toBe(409);

    const transferred = await call("POST", "/workspaces/team/transfer", { userId: admin.id }, owner.token);
    expect(Object.fromEntries(transferred.body.map((m: { email: string; role: string }) => [m.email, m.role]))).toEqual({
      [owner.email]: "admin",
      [admin.email]: "owner",
    });
    expect((await call("DELETE", `/workspaces/team/members/${owner.id}`, undefined, admin.token)).body).toEqual({ ok: true });
    expect((await call("GET", "/workspaces/team", undefined, owner.token)).status).toBe(404);
  });

  it("accepts an invite token once and not after it is revoked", async () => {
    const { call, user } = await start();
    const owner = await user("owner@example.com");
    const joiner = await user("joiner@example.com");
    await call("POST", "/workspaces", { name: "Team", slug: "team" }, owner.token);
    const invite = await call("POST", "/workspaces/team/invites", { email: "someone@example.com", role: "member" }, owner.token);
    expect(invite.body).toMatchObject({ email: "someone@example.com", role: "member", token: expect.any(String), expiresAt: expect.any(String) });
    const listed = await call("GET", "/workspaces/team/invites", undefined, owner.token);
    expect(listed.body).toEqual([expect.not.objectContaining({ token: expect.anything() })]);

    expect((await call("POST", "/invites/accept", { token: invite.body.token })).status).toBe(401);
    expect((await call("POST", "/invites/accept", { token: invite.body.token }, joiner.token)).body).toMatchObject({ role: "member" });
    expect((await call("POST", "/invites/accept", { token: invite.body.token }, joiner.token)).status).toBe(409);
    expect((await call("POST", "/invites/accept", {}, joiner.token)).status).toBe(400);

    const revoked = await call("POST", "/workspaces/team/invites", { email: "later@example.com", role: "viewer" }, owner.token);
    expect((await call("DELETE", `/workspaces/team/invites/${revoked.body.id}`, undefined, owner.token)).body).toEqual({ ok: true });
    expect((await call("POST", "/invites/accept", { token: revoked.body.token }, joiner.token)).status).toBe(404);
    expect((await call("POST", "/workspaces/team/invites", { email: "x@example.com", role: "chief" }, owner.token)).status).toBe(400);
  });

  it("describes the workspace routes and their path parameters in OpenAPI", async () => {
    const { call } = await start();
    const { body } = await call("GET", "/openapi.json");
    const member = body.paths["/workspaces/{ws}/members/{userId}"];
    expect(Object.keys(member).sort()).toEqual(["delete", "patch"]);
    expect(member.patch.parameters.map((p: { name: string; in: string }) => `${p.in}:${p.name}`)).toEqual(["path:ws", "path:userId"]);
    expect(member.patch.requestBody.content["application/json"].schema.properties.role.enum).toEqual(["owner", "admin", "member", "viewer"]);
    expect(body.paths["/invites/accept"].post).toBeDefined();
    expect(body.paths["/projects/{project}/pages"].get.parameters[0]).toMatchObject({ name: "project", in: "path" });
  });

  it("keeps workspaces, members and invites of other workspaces out of reach (REVIEW-0002 R5)", async () => {
    const { call, user } = await start();
    const a = await user("a@example.com");
    const b = await user("b@example.com");
    const bMember = await user("b-member@example.com");
    await call("POST", "/workspaces", { name: "A", slug: "team-a" }, a.token);
    await call("POST", "/workspaces", { name: "B", slug: "team-b" }, b.token);
    const join = await call("POST", "/workspaces/team-b/invites", { email: bMember.email, role: "member" }, b.token);
    await call("POST", "/invites/accept", { token: join.body.token }, bMember.token);
    const bInvite = await call("POST", "/workspaces/team-b/invites", { email: "x@example.com", role: "viewer" }, b.token);

    expect((await call("PATCH", `/workspaces/team-a/members/${bMember.id}`, { role: "viewer" }, a.token)).status).toBe(404);
    expect((await call("DELETE", `/workspaces/team-a/members/${bMember.id}`, undefined, a.token)).status).toBe(404);
    expect((await call("DELETE", `/workspaces/team-a/invites/${bInvite.body.id}`, undefined, a.token)).status).toBe(404);
    expect((await call("POST", "/workspaces/team-a/transfer", { userId: b.id }, a.token)).status).toBe(404);
    expect((await call("GET", "/workspaces/team-b/members", undefined, b.token)).body).toHaveLength(2);
    expect((await call("GET", "/workspaces/team-b/invites", undefined, b.token)).body.map((i: { id: string }) => i.id)).toEqual([bInvite.body.id]);
  });

  it("answers 405 on global routes, and 400 for malformed or slash-encoded path segments (REVIEW-0002 R5)", async () => {
    const { call, user } = await start();
    const dev = await user("dev@example.com");
    expect((await call("DELETE", "/me", undefined, dev.token)).status).toBe(405);
    expect((await call("PUT", "/workspaces", {}, dev.token)).status).toBe(405);
    expect((await call("GET", "/invites/accept", undefined, dev.token)).status).toBe(405);
    expect((await call("POST", "/workspaces/dev/members", {}, dev.token)).status).toBe(405);

    expect((await call("GET", "/workspaces/%zz", undefined, dev.token)).status).toBe(400);
    expect((await call("PATCH", "/workspaces/dev/members/%E0%A4%A", { role: "viewer" }, dev.token)).status).toBe(400);
    // An encoded slash stays inside its segment: this is GET /workspaces/{ws} with ws "dev/members", not the member list.
    expect((await call("GET", "/workspaces/dev%2Fmembers", undefined, dev.token)).status).toBe(400);
    expect((await call("GET", "/workspaces/d%2Fv/members", undefined, dev.token)).status).toBe(400);
    expect((await call("GET", "/workspaces/d%65v/members", undefined, dev.token)).status).toBe(200);
  });

  it("prefers literal path segments over parameters, whatever the order of the routes (REVIEW-0002 R5)", () => {
    type Routes = Parameters<typeof matchRoute>[0];
    const route = (method: "GET" | "POST", path: string) => ({ method, path, global: true, summary: path, tag: "t", handle: async () => path });
    const routes = [route("GET", "/workspaces/{ws}/{inviteId}"), route("GET", "/workspaces/{ws}/members"), route("GET", "/workspaces/new/members")];
    for (const table of [routes, [...routes].reverse()] as Routes[]) {
      expect(matchRoute(table, "GET", "/workspaces/new/members")?.route.path).toBe("/workspaces/new/members");
      expect(matchRoute(table, "GET", "/workspaces/team/members")).toMatchObject({ route: { path: "/workspaces/{ws}/members" }, params: { ws: "team" } });
      // A literal spelled with escapes is a parameter value, not the literal.
      expect(matchRoute(table, "GET", "/workspaces/n%65w/members")).toMatchObject({ route: { path: "/workspaces/{ws}/members" }, params: { ws: "new" } });
      expect(matchRoute(table, "GET", "/workspaces/x")).toBeNull();
      expect(() => matchRoute(table, "POST", "/workspaces/new/members")).toThrow(HttpError);
    }
  });

  it("voids invites past their inviter's authority, and limits revoking to grantable roles (REVIEW-0002 R1, R2)", async () => {
    const { call, user } = await start();
    const owner = await user("owner@example.com");
    const admin = await user("admin@example.com");
    await call("POST", "/workspaces", { name: "Team", slug: "team" }, owner.token);
    const asAdmin = await call("POST", "/workspaces/team/invites", { email: admin.email, role: "admin" }, owner.token);
    await call("POST", "/invites/accept", { token: asAdmin.body.token }, admin.token);

    const kept = await call("POST", "/workspaces/team/invites", { email: "alt@example.com", role: "member" }, admin.token);
    const cto = await call("POST", "/workspaces/team/invites", { email: "cto@example.com", role: "owner" }, owner.token);
    expect((await call("DELETE", `/workspaces/team/invites/${cto.body.id}`, undefined, admin.token)).status).toBe(403);
    expect((await call("POST", "/workspaces/team/invites", { email: "cto@example.com", role: "viewer" }, admin.token)).status).toBe(403);

    expect((await call("DELETE", `/workspaces/team/members/${admin.id}`, undefined, owner.token)).status).toBe(200);
    expect((await call("POST", "/invites/accept", { token: kept.body.token }, admin.token)).status).toBe(404);
    expect((await call("GET", "/workspaces/team", undefined, admin.token)).status).toBe(404);
    expect((await call("GET", "/workspaces/team/invites", undefined, owner.token)).body.map((i: { email: string }) => i.email)).toEqual(["cto@example.com"]);
  });

  it("lets exactly one of two users accept an invite at once, and refuses to transfer to oneself", async () => {
    const { call, user } = await start();
    const owner = await user("owner@example.com");
    const first = await user("first@example.com");
    const second = await user("second@example.com");
    await call("POST", "/workspaces", { name: "Team", slug: "team" }, owner.token);
    const invite = await call("POST", "/workspaces/team/invites", { email: "x@example.com", role: "member" }, owner.token);
    const statuses = await Promise.all([first, second].map(async (u) => (await call("POST", "/invites/accept", { token: invite.body.token }, u.token)).status));
    expect(statuses.sort()).toEqual([200, 409]);
    expect((await call("GET", "/workspaces/team/members", undefined, owner.token)).body).toHaveLength(2);

    expect((await call("POST", "/workspaces/team/transfer", { userId: owner.id }, owner.token)).status).toBe(400);
  });

  it("tells /me how many workspaces the user has, and lets one with none create one (REVIEW-0002 OQ-2)", async () => {
    const { call, user } = await start();
    const dev = await user("dev@example.com");
    expect((await call("GET", "/me", undefined, dev.token)).body).toMatchObject({ user: { id: dev.id }, workspaces: 1 });
    await call("DELETE", "/workspaces/dev", undefined, dev.token);
    // Reading never creates one.
    expect((await call("GET", "/workspaces", undefined, dev.token)).body).toEqual([]);
    expect((await call("GET", "/me", undefined, dev.token)).body.workspaces).toBe(0);
    expect((await call("GET", "/me", undefined, dev.token)).body.workspaces).toBe(0);
    expect((await call("POST", "/workspaces", { name: "Fresh Start" }, dev.token)).body).toMatchObject({ slug: "fresh-start", role: "owner" });
    expect((await call("GET", "/me", undefined, dev.token)).body.workspaces).toBe(1);
  });

  it("redirects a member's request on an old slug to the current one, with 308 (REVIEW-0002 OQ-5)", async () => {
    const { call, user, base } = await start();
    const owner = await user("owner@example.com");
    const stranger = await user("stranger@example.com");
    await call("POST", "/workspaces", { name: "Team", slug: "team" }, owner.token);
    await call("PATCH", "/workspaces/team", { slug: "team-b" }, owner.token);
    await call("PATCH", "/workspaces/team-b", { slug: "team-c" }, owner.token);

    for (const old of ["team", "team-b"]) {
      expect(await call("GET", `/workspaces/${old}/members?x=1&y=a%20b`, undefined, owner.token)).toMatchObject({
        status: 308,
        location: "/workspaces/team-c/members?x=1&y=a%20b",
      });
      const invite = await call("POST", `/workspaces/${old}/invites`, { email: "x@example.com", role: "viewer" }, owner.token);
      expect(invite).toMatchObject({ status: 308, location: "/workspaces/team-c/invites" });
      // Non-members learn nothing: an alias is a 404 like an unknown slug.
      expect((await call("GET", `/workspaces/${old}`, undefined, stranger.token)).status).toBe(404);
      expect((await call("GET", `/workspaces/${old}/members`, undefined, stranger.token)).status).toBe(404);
    }
    expect((await call("GET", "/workspaces/team-c", undefined, owner.token)).status).toBe(200);
    expect((await call("POST", "/workspaces", { name: "Mine", slug: "team" }, stranger.token)).status).toBe(409);

    // Following the redirect keeps the method and body.
    const followed = await fetch(`${base}/workspaces/team/invites`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "y@example.com", role: "viewer" }),
    });
    expect(followed.status).toBe(200);
    expect(await followed.json()).toMatchObject({ email: "y@example.com", role: "viewer" });

    // Deleting the workspace frees its old slugs.
    expect((await call("DELETE", "/workspaces/team-c", undefined, owner.token)).status).toBe(200);
    expect((await call("GET", "/workspaces/team", undefined, owner.token)).status).toBe(404);
    expect((await call("POST", "/workspaces", { name: "Mine", slug: "team" }, stranger.token)).status).toBe(200);
  });
});
