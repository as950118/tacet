import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTacetApiServer, type TacetApiServer, type TacetApiServerOptions } from "../src/server.js";

const TOKEN = "machine-token";
const PASSWORD = "correct horse battery";

/** PostgreSQL runs too when a server is given, e.g. TACET_TEST_POSTGRES_URL=postgres://tacet:tacet@localhost:55432/tacet */
const postgresUrl = process.env.TACET_TEST_POSTGRES_URL;
const schema = `tacet_accounts_api_test_${process.pid}_${Date.now()}`;
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

describe.each(backends)("accounts over HTTP on $name", ({ location }) => {
  let dir: string;
  const servers: TacetApiServer[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tacet-accounts-api-"));
  });
  afterAll(async () => {
    for (const api of servers) await api.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async (options: Partial<TacetApiServerOptions> = {}) => {
    const api = await createTacetApiServer({ index: location(dir), token: TOKEN, accounts: true, ...options });
    servers.push(api);
    const base = await api.listen(0);
    return async (method: string, path: string, body?: unknown, token?: string | null) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    };
  };

  it("signs up, reads the current user and logs out", async () => {
    const call = await start();
    expect((await call("GET", "/health")).body).toMatchObject({ accounts: true });

    const signup = await call("POST", "/auth/signup", { email: "Dev@Example.com", password: PASSWORD, displayName: "Dev" });
    expect(signup.status).toBe(200);
    expect(signup.body).toMatchObject({ user: { email: "dev@example.com", displayName: "Dev" }, token: expect.any(String) });
    expect(signup.body.user).not.toHaveProperty("passwordHash");
    const token = signup.body.token as string;

    expect((await call("GET", "/me", undefined, token)).body).toEqual({ user: signup.body.user });
    expect((await call("GET", "/me")).status).toBe(401);
    expect((await call("GET", "/me", undefined, TOKEN)).status).toBe(401);
    expect((await call("POST", "/auth/signup", { email: "dev@example.com", password: PASSWORD })).status).toBe(409);

    expect((await call("POST", "/auth/logout", undefined, token)).status).toBe(200);
    expect((await call("GET", "/me", undefined, token)).status).toBe(401);
  });

  it("keeps the machine routes for the machine token only", async () => {
    const call = await start();
    const { body } = await call("POST", "/auth/signup", { email: "user@example.com", password: PASSWORD });
    expect((await call("GET", "/projects", undefined, body.token)).status).toBe(401);
    expect((await call("GET", "/projects", undefined, TOKEN)).status).toBe(200);
  });

  it("lets a user through when the server has no token (open, loopback only)", async () => {
    const call = await start({ token: undefined });
    const { body } = await call("POST", "/auth/signup", { email: "open@example.com", password: PASSWORD });
    expect((await call("GET", "/projects", undefined, body.token)).status).toBe(200);
    expect((await call("GET", "/me", undefined, body.token)).status).toBe(200);
    expect((await call("GET", "/me")).status).toBe(401);
  });

  it("validates sign-ups and throttles repeated failed logins", async () => {
    const call = await start();
    expect((await call("POST", "/auth/signup", { email: "nope", password: PASSWORD })).status).toBe(400);
    expect((await call("POST", "/auth/signup", { email: "short@example.com", password: "short" })).status).toBe(400);
    expect((await call("POST", "/auth/signup", { email: "x@example.com" })).status).toBe(400);
    await call("POST", "/auth/signup", { email: "victim@example.com", password: PASSWORD });

    for (let i = 0; i < 10; i++) {
      expect((await call("POST", "/auth/login", { email: "victim@example.com", password: `guess number ${i}` })).status).toBe(401);
    }
    const blocked = await call("POST", "/auth/login", { email: "victim@example.com", password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("describes the account routes in OpenAPI as callable without the machine token", async () => {
    const call = await start();
    const { body } = await call("GET", "/openapi.json");
    expect(body.paths["/auth/login"].post.security).toEqual([]);
    expect(body.paths["/me"].get.security).toBeUndefined();
  });

  it("has no account routes unless asked", async () => {
    const call = await start({ accounts: false });
    expect((await call("POST", "/auth/login", { email: "a@example.com", password: PASSWORD })).status).toBe(404);
    expect((await call("GET", "/health")).body).toMatchObject({ accounts: false });
  });
});
