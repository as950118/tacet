import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTacetApiServer, type TacetApiServer } from "../src/server.js";

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
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    /** Signs up and returns the user and their session token. */
    const user = async (email: string) => {
      const { body } = await call("POST", "/auth/signup", { email, password: PASSWORD });
      return { id: body.user.id as string, email, token: body.token as string };
    };
    return { call, user };
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
    expect((await call("GET", "/workspaces/acme", undefined, dev.token)).status).toBe(404);
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
});
