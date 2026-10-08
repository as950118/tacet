import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexStore } from "../src/index-store/index-store.js";
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

describe("IndexStore", () => {
  let dir: string;
  let store: IndexStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tacet-index-store-"));
    store = IndexStore.open(join(dir, "index.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a frontend manifest and reads it back", () => {
    const manifest = sampleFrontend();
    const update = store.writeManifest(manifest);
    expect(update.summary).toEqual({ files: 2, functions: 1, apiCalls: 2, resolvedApiCalls: 2, propertyAccesses: 1 });
    expect(update.changedFiles).toEqual(["src/pages/Product.tsx", "src/pages/User.tsx"]);
    const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
    const read = store.readFrontendManifest()!;
    expect(byId(read.apiCalls)).toEqual(byId(manifest.apiCalls));
    expect(read.propertyAccesses).toEqual(manifest.propertyAccesses);
    expect(read.functions).toEqual(manifest.functions);
    expect(read.files.map((f) => f.path).sort()).toEqual(manifest.files.map((f) => f.path).sort());
  });

  it("reports only files whose records changed on re-index", () => {
    store.writeManifest(sampleFrontend());
    const changed = sampleFrontend();
    changed.propertyAccesses[0] = { ...changed.propertyAccesses[0], path: ["username"] };
    expect(store.writeManifest(changed).changedFiles).toEqual(["src/pages/User.tsx"]);
    expect(store.writeManifest(changed).changedFiles).toEqual([]);
  });

  it("drops records of deleted files", () => {
    store.writeManifest(sampleFrontend());
    const withoutProduct = sampleFrontend();
    withoutProduct.apiCalls = withoutProduct.apiCalls.filter((c) => c.file !== "src/pages/Product.tsx");
    withoutProduct.files = withoutProduct.files.filter((f) => f.path !== "src/pages/Product.tsx");
    const update = store.writeManifest(withoutProduct);
    expect(update.changedFiles).toEqual(["src/pages/Product.tsx"]);
    expect(update.summary.files).toBe(1);
    expect(store.listApiCalls().map((c) => c.id)).toEqual(["call:a"]);
  });

  it("finds api calls by endpoint and accesses by call", () => {
    store.writeManifest(sampleFrontend());
    expect(store.findApiCallsByEndpoint("GET", "/users/{param}").map((c) => c.id)).toEqual(["call:a"]);
    expect(store.findPropertyAccessesForApiCall("call:a").map((a) => a.path)).toEqual([["name"]]);
  });

  it("stores the backend manifest and reports changed endpoints", () => {
    const manifest = backend(
      [endpoint("GET", "/users/{id}", t.dto("User")), endpoint("DELETE", "/users/{id}", null)],
      [dto("User", { name: t.scalar("String") })],
    );
    expect(store.writeBackendManifest(manifest).changedEndpoints).toEqual(["DELETE /users/{id}", "GET /users/{id}"]);
    expect(store.readBackendManifest()).toEqual({
      ...manifest,
      endpoints: [...manifest.endpoints].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    });

    const changed = backend([endpoint("GET", "/users/{id}", t.dto("User"))], manifest.dtos);
    expect(store.writeBackendManifest(changed).changedEndpoints).toEqual(["DELETE /users/{id}"]);
  });

  it("returns null manifests for an empty index", () => {
    expect(store.readFrontendManifest()).toBeNull();
    expect(store.readBackendManifest()).toBeNull();
  });

  it("persists the config used at index time", () => {
    store.writeConfig({ linking: { frontendBasePath: "/api" } });
    expect(store.readConfig()).toEqual({ linking: { frontendBasePath: "/api" } });
  });

  it("rebuilds an index created with an older schema", () => {
    store.close();
    const path = join(dir, "old.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("INSERT INTO index_meta VALUES ('schemaVersion', '1')");
    db.exec("CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT)");
    db.close();
    store = IndexStore.open(path);
    expect(store.getMeta("schemaVersion")).toBe("5");
    expect(store.writeManifest(sampleFrontend()).summary.files).toBe(2);
  });
});
