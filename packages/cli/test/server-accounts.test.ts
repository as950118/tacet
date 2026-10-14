import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

    expect((await call("GET", "/me", undefined, token)).body).toEqual({ user: signup.body.user, workspaces: 1 });
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

/** QA-0001: black-box cases for TASK-0002/0003 (PRD-0001 AC-1 API part, AC-7) not covered above. */
describe.each(backends)("QA-0001 accounts over HTTP on $name", ({ location }) => {
  const fixtures = join(fileURLToPath(new URL("../../../", import.meta.url)), "test/fixtures");
  let dir: string;
  const servers: TacetApiServer[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tacet-accounts-qa-"));
  });
  afterAll(async () => {
    for (const api of servers) await api.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = async (index: string, options: Partial<TacetApiServerOptions> = {}) => {
    const api = await createTacetApiServer({ index, token: TOKEN, accounts: true, ...options });
    servers.push(api);
    const base = await api.listen(0);
    const call = async (method: string, path: string, init: { body?: unknown; raw?: string; token?: string; headers?: Record<string, string> } = {}) => {
      const hasBody = init.body !== undefined || init.raw !== undefined;
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    };
    return { api, call };
  };
  const start = async (options: Partial<TacetApiServerOptions> = {}) => (await open(location(dir), options)).call;

  it("accepts passwords of 10 to 256 characters and nothing else", async () => {
    const call = await start();
    for (const [length, status] of [[9, 400], [10, 200], [256, 200], [257, 400]] as const) {
      const res = await call("POST", "/auth/signup", { body: { email: `len${length}@example.com`, password: "p".repeat(length) } });
      expect(res.status, `password of ${length}`).toBe(status);
    }
    expect((await call("POST", "/auth/login", { body: { email: "len256@example.com", password: "p".repeat(256) } })).status).toBe(200);
    expect((await call("POST", "/auth/login", { body: { email: "len256@example.com", password: "p".repeat(257) } })).status).toBe(401);
  });

  it("answers malformed bodies and wrong field types with 400", async () => {
    const call = await start();
    for (const raw of ["{not json", "[]", '"text"', ""]) {
      expect((await call("POST", "/auth/signup", { raw })).status, `body ${JSON.stringify(raw)}`).toBe(400);
      expect((await call("POST", "/auth/login", { raw })).status, `body ${JSON.stringify(raw)}`).toBe(400);
    }
    for (const body of [
      { email: 1, password: PASSWORD },
      { email: null, password: PASSWORD },
      { email: "t@example.com", password: ["x".repeat(12)] },
      { email: "t@example.com", password: { value: PASSWORD } },
      { email: "t@example.com", password: PASSWORD, displayName: 7 },
    ]) {
      expect((await call("POST", "/auth/signup", { body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("POST", "/auth/login", { body: { email: "t@example.com", password: 1234567890 } })).status).toBe(400);
  });

  it("treats emails case- and space-insensitively and gives one error for any wrong credentials", async () => {
    const call = await start();
    expect((await call("POST", "/auth/signup", { body: { email: " Case@Example.COM ", password: PASSWORD } })).status).toBe(200);
    for (const email of ["case@example.com", "CASE@EXAMPLE.COM", "  case@example.com  "]) {
      expect((await call("POST", "/auth/signup", { body: { email, password: PASSWORD } })).status, email).toBe(409);
    }
    expect((await call("POST", "/auth/login", { body: { email: "CASE@example.com ", password: PASSWORD } })).status).toBe(200);
    const wrongPassword = await call("POST", "/auth/login", { body: { email: "case@example.com", password: "not the password" } });
    const unknownEmail = await call("POST", "/auth/login", { body: { email: "nobody@example.com", password: "not the password" } });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it("logs out only the session it is called with", async () => {
    const call = await start();
    const first = (await call("POST", "/auth/signup", { body: { email: "two@example.com", password: PASSWORD } })).body.token as string;
    const second = (await call("POST", "/auth/login", { body: { email: "two@example.com", password: PASSWORD } })).body.token as string;
    expect(second).not.toBe(first);
    expect((await call("POST", "/auth/logout", { token: second })).status).toBe(200);
    const gone = await call("GET", "/me", { token: second });
    expect(gone.status).toBe(401);
    expect(gone.headers.get("www-authenticate")).toBe("Bearer");
    expect((await call("POST", "/auth/logout", { token: second })).status).toBe(401);
    expect((await call("POST", "/auth/logout", { token: TOKEN })).status).toBe(401);
    expect((await call("GET", "/me", { token: first })).status).toBe(200);
  });

  it("keeps users and sessions when the server restarts", async () => {
    const index = location(dir);
    const before = await open(index);
    const signup = await before.call("POST", "/auth/signup", { body: { email: "stay@example.com", password: PASSWORD } });
    await before.api.close();
    servers.splice(servers.indexOf(before.api), 1);

    const { call } = await open(index);
    expect((await call("GET", "/me", { token: signup.body.token })).body).toEqual({ user: signup.body.user, workspaces: 1 });
    expect((await call("POST", "/auth/login", { body: { email: "stay@example.com", password: PASSWORD } })).status).toBe(200);
    expect((await call("POST", "/auth/signup", { body: { email: "stay@example.com", password: PASSWORD } })).status).toBe(409);
  });

  it("keeps the legacy project routes for the machine token only (AC-7)", async () => {
    const call = await start({ allowDirs: [fixtures], configPath: join(fixtures, "tacet.config.json") });
    const user = (await call("POST", "/auth/signup", { body: { email: "legacy@example.com", password: PASSWORD } })).body.token as string;
    const frontend = { dir: join(fixtures, "frontend") };
    expect((await call("POST", "/projects/legacy/frontend", { body: frontend, token: user })).status).toBe(401);
    expect((await call("POST", "/projects/legacy/frontend", { body: frontend, token: TOKEN })).status).toBe(200);
    const pages = await call("GET", "/projects/legacy/pages", { token: TOKEN });
    expect(pages.status).toBe(200);
    expect(pages.body.length).toBeGreaterThan(0);
    expect((await call("GET", "/projects/legacy/pages", { token: user })).status).toBe(401);
    expect((await call("GET", "/projects/legacy/pages")).status).toBe(401);
  });

  it("takes the client address from X-Forwarded-For only with trustProxy", async () => {
    const fail = (call: Awaited<ReturnType<typeof start>>, email: string, forwarded: string) =>
      call("POST", "/auth/login", { body: { email, password: "not the password" }, headers: { "X-Forwarded-For": forwarded } });

    // Without trustProxy a forged header does not give each attempt a fresh address.
    const direct = await start();
    await direct("POST", "/auth/signup", { body: { email: "direct@example.com", password: PASSWORD } });
    for (let i = 0; i < 10; i++) expect((await fail(direct, `spray${i}@example.com`, `10.0.0.${i}`)).status).toBe(401);
    expect((await fail(direct, "direct@example.com", "10.0.1.1")).status).toBe(429);

    // With trustProxy the per-address limit follows the forwarded address; the per-email limit still holds.
    const proxied = await start({ trustProxy: true });
    await proxied("POST", "/auth/signup", { body: { email: "proxied@example.com", password: PASSWORD } });
    for (let i = 0; i < 10; i++) expect((await fail(proxied, "target@example.com", `10.1.0.${i}`)).status).toBe(401);
    const blocked = await fail(proxied, "target@example.com", "10.1.9.9");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    const other = await proxied("POST", "/auth/login", { body: { email: "proxied@example.com", password: PASSWORD }, headers: { "X-Forwarded-For": "10.1.9.8" } });
    expect(other.status).toBe(200);
  });
});
