import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openIndexDatabase, type IndexDatabase, type IndexStore } from "../src/index-store/index-store.js";
import { redactLocation } from "../src/index-store/driver.js";
import { buildOntology } from "../src/analysis/ontology.js";
import { ProjectModel } from "../src/analysis/model.js";
import { access, backend, call, dto, endpoint, fn, frontend, t } from "./builders.js";

function sampleFrontend() {
  return frontend(
    [
      call("call:a", "GET", "/users/{param}", { file: "src/pages/User.tsx", callerFunctionId: "fn:page" }),
      call("call:b", "GET", "/products/{param}", { file: "src/pages/Product.tsx" }),
    ],
    [access("prop:a", "call:a", ["name"], { file: "src/pages/User.tsx" })],
    [fn("fn:page", "src/pages/User.tsx", "fn:page")],
  );
}

/** PostgreSQL runs too when a server is given, e.g. TACET_TEST_POSTGRES_URL=postgres://tacet:tacet@localhost:55432/tacet */
const postgresUrl = process.env.TACET_TEST_POSTGRES_URL;
const schema = `tacet_test_${process.pid}_${Date.now()}`;

const backends: Array<{ name: string; location: (dir: string) => string }> = [
  { name: "SQLite", location: (dir) => join(dir, "index.db") },
  ...(postgresUrl
    ? [{ name: "PostgreSQL", location: () => `${postgresUrl}${postgresUrl.includes("?") ? "&" : "?"}schema=${schema}` }]
    : []),
];

afterAll(async () => {
  if (!postgresUrl) return;
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
});

describe.each(backends)("IndexStore on $name", ({ location }) => {
  let dir: string;
  let db: IndexDatabase;
  let store: IndexStore;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tacet-index-store-"));
  });

  beforeEach(async () => {
    db = await openIndexDatabase(location(dir));
    store = db.project(`p${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    await store.clear();
    await db.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a frontend manifest and reads it back", async () => {
    const manifest = sampleFrontend();
    const update = await store.writeManifest(manifest);
    expect(update.summary).toEqual({ files: 2, functions: 1, apiCalls: 2, resolvedApiCalls: 2, propertyAccesses: 1 });
    expect(update.changedFiles).toEqual(["src/pages/Product.tsx", "src/pages/User.tsx"]);
    const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
    const read = (await store.readFrontendManifest())!;
    expect(byId(read.apiCalls)).toEqual(byId(manifest.apiCalls));
    expect(read.propertyAccesses).toEqual(manifest.propertyAccesses);
    expect(read.functions).toEqual(manifest.functions);
    expect(read.files.map((f) => f.path).sort()).toEqual(manifest.files.map((f) => f.path).sort());
  });

  it("reports only files whose records changed on re-index", async () => {
    await store.writeManifest(sampleFrontend());
    const changed = sampleFrontend();
    changed.propertyAccesses[0] = { ...changed.propertyAccesses[0], path: ["username"] };
    expect((await store.writeManifest(changed)).changedFiles).toEqual(["src/pages/User.tsx"]);
    expect((await store.writeManifest(changed)).changedFiles).toEqual([]);
  });

  it("drops records of deleted files", async () => {
    await store.writeManifest(sampleFrontend());
    const withoutProduct = sampleFrontend();
    withoutProduct.apiCalls = withoutProduct.apiCalls.filter((c) => c.file !== "src/pages/Product.tsx");
    withoutProduct.files = withoutProduct.files.filter((f) => f.path !== "src/pages/Product.tsx");
    const update = await store.writeManifest(withoutProduct);
    expect(update.changedFiles).toEqual(["src/pages/Product.tsx"]);
    expect(update.summary.files).toBe(1);
    expect((await store.listApiCalls()).map((c) => c.id)).toEqual(["call:a"]);
  });

  it("finds api calls by endpoint and accesses by call", async () => {
    await store.writeManifest(sampleFrontend());
    expect((await store.findApiCallsByEndpoint("GET", "/users/{param}")).map((c) => c.id)).toEqual(["call:a"]);
    expect((await store.findPropertyAccessesForApiCall("call:a")).map((a) => a.path)).toEqual([["name"]]);
  });

  it("stores the backend manifest and reports changed endpoints", async () => {
    const manifest = backend(
      [endpoint("GET", "/users/{id}", t.dto("User")), endpoint("DELETE", "/users/{id}", null)],
      [dto("User", { name: t.scalar("String") })],
    );
    expect((await store.writeBackendManifest(manifest)).changedEndpoints).toEqual(["DELETE /users/{id}", "GET /users/{id}"]);
    expect(await store.readBackendManifest()).toEqual({
      ...manifest,
      endpoints: [...manifest.endpoints].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    });

    const changed = backend([endpoint("GET", "/users/{id}", t.dto("User"))], manifest.dtos);
    expect((await store.writeBackendManifest(changed)).changedEndpoints).toEqual(["DELETE /users/{id}"]);
  });

  it("returns null manifests for an empty index", async () => {
    expect(await store.readFrontendManifest()).toBeNull();
    expect(await store.readBackendManifest()).toBeNull();
  });

  it("persists the config used at index time", async () => {
    await store.writeConfig({ linking: { frontendBasePath: "/api" } });
    expect(await store.readConfig()).toEqual({ linking: { frontendBasePath: "/api" } });
  });

  it("stores relations and answers page / API queries", async () => {
    const fe = sampleFrontend();
    const be = backend([endpoint("GET", "/users/{id}", t.dto("User"))], [dto("User", { name: t.scalar("String") })]);
    await store.writeManifest(fe);
    await store.writeBackendManifest(be);
    const ontology = buildOntology(new ProjectModel(fe, be), { includeUnrelated: true });
    const written = await store.writeRelations(ontology, { commonApis: { share: 0.5 } });
    expect(written.relations).toBe(ontology.triples.length);
    expect(await store.relationsBuiltWith({ commonApis: { share: 0.5 } })).toBe(true);

    const [endpointEntity] = await store.findEntitiesByKey("GET /users/{id}", "Endpoint");
    expect(endpointEntity.class).toBe("Endpoint");
    expect(await store.getEntity(endpointEntity.id)).toEqual(endpointEntity);
    const handled = await store.queryRelations({ subject: endpointEntity.id, predicate: "handledBy" });
    expect(handled.map((r) => r.predicate)).toEqual(["handledBy"]);
    expect(await store.queryRelations({ predicate: "requests", limit: 1 })).toHaveLength(1);

    // Rewriting replaces rather than accumulates.
    await store.writeRelations(ontology);
    expect((await store.queryRelations()).length).toBe(new Set(ontology.triples.map((t) => `${t.subject} ${t.predicate} ${t.object}`)).size);
  });

  it("keeps projects apart", async () => {
    const other = db.project(`${store.project}-other`);
    try {
      await store.writeManifest(sampleFrontend());
      expect(await other.readFrontendManifest()).toBeNull();
      const onlyUser = sampleFrontend();
      onlyUser.apiCalls = onlyUser.apiCalls.slice(0, 1);
      await other.writeManifest(onlyUser);
      expect((await store.summary()).apiCalls).toBe(2);
      expect((await other.summary()).apiCalls).toBe(1);
      const names = (await db.listProjects()).map((p) => p.name);
      expect(names).toEqual(expect.arrayContaining([store.project, other.project]));
      await other.clear();
      expect((await db.listProjects()).map((p) => p.name)).not.toContain(other.project);
      expect((await store.summary()).apiCalls).toBe(2);
    } finally {
      await other.clear();
    }
  });

  it("serializes concurrent writers of one project", async () => {
    const a = sampleFrontend();
    const b = sampleFrontend();
    b.propertyAccesses[0] = { ...b.propertyAccesses[0], path: ["email"] };
    await Promise.all([store.writeManifest(a), store.writeManifest(b), store.writeManifest(a)]);
    expect((await store.summary()).propertyAccesses).toBe(1);
  });
});

describe("index databases", () => {
  it("rebuilds a SQLite index created with an older schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tacet-index-old-"));
    try {
      const path = join(dir, "old.db");
      const raw = new DatabaseSync(path);
      raw.exec("CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      raw.exec("INSERT INTO index_meta VALUES ('schemaVersion', '5')");
      raw.exec("CREATE TABLE files (id TEXT PRIMARY KEY, file TEXT NOT NULL, json TEXT NOT NULL)");
      raw.close();
      const db = await openIndexDatabase(path);
      const store = db.project();
      expect(store.project).toBe("default");
      expect((await store.writeManifest(sampleFrontend())).summary.files).toBe(2);
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hides passwords in locations", () => {
    expect(redactLocation("postgres://tacet:secret@db:5432/x?schema=a")).toBe("postgres://tacet:***@db:5432/x?schema=a");
    expect(redactLocation(".tacet/index.db")).toBe(".tacet/index.db");
  });
});
