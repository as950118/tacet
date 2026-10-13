import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_JAR_PATH } from "@tacet-api/extractor-java";
import { createTacetApiServer, type TacetApiServer } from "../src/server.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = join(repoRoot, "test/fixtures");
const hasJar = existsSync(DEFAULT_JAR_PATH);
const TOKEN = "test-token";

/** PostgreSQL runs too when a server is given, e.g. TACET_TEST_POSTGRES_URL=postgres://tacet:tacet@localhost:55432/tacet */
const postgresUrl = process.env.TACET_TEST_POSTGRES_URL;
const schema = `tacet_api_test_${process.pid}_${Date.now()}`;
const backends = [
  { name: "SQLite", location: (dir: string) => join(dir, "index.db") },
  ...(postgresUrl ? [{ name: "PostgreSQL", location: () => `${postgresUrl}${postgresUrl.includes("?") ? "&" : "?"}schema=${schema}` }] : []),
];

afterAll(async () => {
  if (!postgresUrl) return;
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
});

describe.each(backends)("Tacet HTTP API on $name", ({ location }) => {
  let dir: string;
  let api: TacetApiServer;
  let base: string;

  const call = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, type, body: type.startsWith("application/json") ? await res.json() : await res.text() };
  };
  const get = (path: string) => call("GET", path);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tacet-api-"));
    api = await createTacetApiServer({
      index: location(dir),
      configPath: join(fixtures, "tacet.config.json"),
      token: TOKEN,
      allowDirs: [fixtures],
    });
    base = await api.listen(0);
    const indexed = await call("POST", "/projects/admin/frontend", { dir: join(fixtures, "frontend") });
    expect(indexed.status).toBe(200);
    expect(indexed.body).toMatchObject({ project: "admin", summary: { apiCalls: 15 } });
  });

  afterAll(async () => {
    await call("DELETE", "/projects/admin");
    await api?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves health and the OpenAPI document without a token, everything else only with it", async () => {
    const health = await call("GET", "/health", undefined, null);
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");
    expect(JSON.stringify(health.body)).not.toContain("tacet:tacet@");

    const openapi = await call("GET", "/openapi.json", undefined, null);
    expect(openapi.body.openapi).toBe("3.1.0");
    expect(Object.keys(openapi.body.paths)).toEqual(
      expect.arrayContaining(["/projects", "/projects/{project}/pages", "/projects/{project}/frontend"]),
    );

    expect((await call("GET", "/projects", undefined, null)).status).toBe(401);
    expect((await call("GET", "/projects", undefined, "wrong")).status).toBe(401);
  });

  it("lists projects and their status", async () => {
    const projects = await get("/projects");
    expect(projects.body.map((p: { name: string }) => p.name)).toContain("admin");
    const status = await get("/projects/admin");
    expect(status.body).toMatchObject({ project: "admin", backend: null, summary: { files: 9 } });
  });

  it("answers which page uses which API", async () => {
    const pages = await get("/projects/admin/pages");
    expect(pages.body.map((p: { component: string }) => p.component).sort()).toEqual(["UserList", "UserPage"]);
    const byApi = await get(`/projects/admin/pages?api=${encodeURIComponent("GET /users/{param}")}`);
    expect(byApi.body[0].pages.map((p: { component: string }) => p.component)).toEqual(["UserPage"]);

    const relations = await get("/projects/admin/relations?subject=UserPage&predicate=renders");
    expect(relations.body.relations.map((t: { object: string }) => relations.body.entities[t.object].label)).toContain("UserCard");
    expect((await get("/projects/admin/relations")).status).toBe(400);
    expect((await get("/projects/admin/relations?page=/nope")).status).toBe(404);
  });

  it("renders the ontology in every format", async () => {
    const turtle = await get("/projects/admin/ontology?format=turtle&focus=UserCard");
    expect(turtle.type).toContain("text/turtle");
    expect(turtle.body).toMatch(/^@prefix tacet:/);
    const html = await get("/projects/admin/ontology?format=html");
    expect(html.type).toContain("text/html");
    expect((await get("/projects/admin/ontology?format=xml")).status).toBe(400);
    expect((await get("/projects/admin/ontology?focus=Nothing")).status).toBe(404);
  });

  it("answers impact and search questions", async () => {
    const impact = await get(`/projects/admin/impact?file=src/api/user.ts`);
    expect(impact.body.file).toBe("src/api/user.ts");
    const search = await get("/projects/admin/search?q=UserCard");
    expect(search.body.some((hit: { label: string }) => hit.label === "UserCard")).toBe(true);
    expect((await get("/projects/admin/search")).status).toBe(400);
    const graph = await get("/projects/admin/graph?format=mermaid");
    expect(graph.body).toMatch(/^flowchart LR/);
  });

  it("refuses directories outside the allowed ones, bad names and unknown projects", async () => {
    expect((await call("POST", "/projects/admin/frontend", { dir: tmpdir() })).status).toBe(403);
    expect((await call("POST", "/projects/admin/frontend", {})).status).toBe(400);
    const outsideConfig = { dir: join(fixtures, "frontend"), config: join(tmpdir(), "tacet.config.json") };
    expect((await call("POST", "/projects/admin/frontend", outsideConfig)).status).toBe(403);
    expect((await call("POST", "/projects/admin/frontend", { dir: join(fixtures, "frontend"), files: "x" })).status).toBe(400);
    expect((await get("/projects/bad%20name/pages")).status).toBe(400);
    const missing = await get("/projects/nobody/pages");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain('project "nobody"');
    expect((await get("/projects/admin/nothing")).status).toBe(404);
    expect((await call("PUT", "/projects/admin/pages")).status).toBe(405);
  });

  it.skipIf(!hasJar)("indexes the backend and checks the contract", async () => {
    const extracted = await call("POST", "/projects/admin/backend", { dir: join(fixtures, "backend") });
    expect(extracted.status).toBe(200);
    expect(extracted.body.endpoints).toBeGreaterThan(0);
    const failing = await get("/projects/admin/check");
    expect(failing.body.result).toBe("FAIL");
    const passing = await get("/projects/admin/check?files=src/pages/Product.tsx");
    expect(passing.body.result).toBe("PASS");
    const unused = await get("/projects/admin/unused");
    expect(unused.body.endpoints.map((e: { endpoint: string }) => e.endpoint)).toContain("GET /users/summary");

    // Another frontend on the same backend counts by default; `alone` leaves it out.
    expect((await call("POST", "/projects/admin-copy/frontend", { dir: join(fixtures, "frontend") })).status).toBe(200);
    expect((await call("POST", "/projects/admin-copy/backend", { dir: join(fixtures, "backend") })).status).toBe(200);
    const together = await get("/projects/admin/unused");
    expect(together.body.frontends.map((f: { name: string }) => f.name)).toEqual(["admin", "admin-copy"]);
    const alone = await get("/projects/admin/unused?alone");
    expect(alone.body.frontends.map((f: { name: string }) => f.name)).toEqual(["frontend"]);
    await call("DELETE", "/projects/admin-copy");
  });
});

describe("Tacet HTTP API, read-only", () => {
  it("serves queries but no indexing or deleting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tacet-api-ro-"));
    const api = await createTacetApiServer({ index: join(dir, "index.db"), allowDirs: [fixtures], readOnly: true });
    try {
      const base = await api.listen(0);
      const health = await (await fetch(`${base}/health`)).json();
      expect(health.readOnly).toBe(true);
      const post = await fetch(`${base}/projects/admin/frontend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: join(fixtures, "frontend") }),
      });
      expect(post.status).toBe(403);
      expect((await fetch(`${base}/projects/admin`, { method: "DELETE" })).status).toBe(403);
      expect((await fetch(`${base}/projects`)).status).toBe(200);
      const openapi = await (await fetch(`${base}/openapi.json`)).json();
      expect(Object.keys(openapi.paths)).not.toContain("/projects/{project}/frontend");
    } finally {
      await api.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
