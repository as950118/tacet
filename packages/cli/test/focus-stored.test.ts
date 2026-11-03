import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildOntology, focusOntology, type Ontology } from "@tacet-api/core";
import { DEFAULT_JAR_PATH } from "@tacet-api/extractor-java";
import { TacetWorkspace } from "../src/workspace.js";

const fixtures = join(fileURLToPath(new URL("../../../", import.meta.url)), "test/fixtures");
const hasJar = existsSync(DEFAULT_JAR_PATH);

/** PostgreSQL runs too when a server is given, e.g. TACET_TEST_POSTGRES_URL=postgres://tacet:tacet@localhost:55432/tacet */
const postgresUrl = process.env.TACET_TEST_POSTGRES_URL;
const schema = `tacet_focus_test_${process.pid}_${Date.now()}`;
const databases = [
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

const byTriple = (a: { subject: string; predicate: string; object: string }, b: typeof a) =>
  a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate) || a.object.localeCompare(b.object);
/** Triples have no meaningful order; everything else must match exactly. */
const normalized = (o: Ontology) => ({ ...o, triples: [...o.triples].sort(byTriple) });

const cases = databases.flatMap((d) => [{ ...d, backend: false }, { ...d, backend: true }]);

describe.each(cases)("a focused ontology read from the stored relations ($name, backend: $backend)", ({ location, backend }) => {
  if (backend && !hasJar) return it.skip("needs the Java extractor jar", () => undefined);
  let dir: string;
  let ws: TacetWorkspace;
  let full: Ontology;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tacet-focus-"));
    ws = new TacetWorkspace(location(dir), join(fixtures, "tacet.config.json"));
    await ws.indexFrontend(join(fixtures, "frontend"));
    if (backend) await ws.extractBackend(join(fixtures, "backend"));
    full = buildOntology(await ws.model());
  });
  afterAll(async () => {
    await ws.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches focusOntology on the whole model for every entity, depth and file setting", async () => {
    const queries = [...new Set(full.entities.flatMap((e) => [e.id, e.label]))];
    expect(queries.length).toBeGreaterThan(10);
    let compared = 0;
    for (const includeFiles of [true, false]) {
      const whole = buildOntology(await ws.model(), { includeFiles });
      for (const focus of queries) {
        for (const depth of [1, 2, 3]) {
          let expected: Ontology | undefined;
          try {
            expected = focusOntology(whole, focus, depth);
          } catch {
            expected = undefined;
          }
          const actual = await ws.ontology({ focus, depth, includeFiles });
          // A query that matches nothing in this view leaves both empty (the server answers 404 for it).
          expect(normalized(actual), `${focus} depth ${depth} files ${includeFiles}`).toEqual(normalized(expected!));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(50);
  });

  it("leaves out the functions the default ontology prunes", async () => {
    const pruned = buildOntology(await ws.model());
    const all = buildOntology(await ws.model(), { includeUnrelated: true });
    expect(all.entities.length).toBeGreaterThan(pruned.entities.length);
    const focused = await ws.ontology({ focus: "UserPage", depth: 3 });
    const ids = new Set(pruned.entities.map((e) => e.id));
    expect(focused.entities.every((e) => ids.has(e.id))).toBe(true);
  });

  it("does not load the model for a focused query", async () => {
    const model = vi.spyOn(ws, "model");
    await ws.ontology({ focus: "UserCard" });
    await ws.ontology({ focus: "UserCard", includeFiles: false, depth: 3 });
    expect(model).not.toHaveBeenCalled();
    model.mockRestore();
  });

  it("matches on a substring query too", async () => {
    const whole = buildOntology(await ws.model());
    expect(normalized(await ws.ontology({ focus: "user" }))).toEqual(normalized(focusOntology(whole, "user")));
    expect((await ws.ontology({ focus: "no-such-thing" })).entities).toEqual([]);
  });

  it("keeps the whole-model path for includeUnrelated", async () => {
    const whole = buildOntology(await ws.model(), { includeUnrelated: true });
    expect(normalized(await ws.ontology({ focus: "UserCard", includeUnrelated: true }))).toEqual(
      normalized(focusOntology(whole, "UserCard")),
    );
  });
});
