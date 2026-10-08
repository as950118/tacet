import { describe, expect, it } from "vitest";
import { buildOntology, focusOntology, pagesByApi, type Ontology } from "../src/analysis/ontology.js";
import { ProjectModel } from "../src/analysis/model.js";
import { renderOntologyHtml, renderOntologyMermaid, renderOntologyTurtle } from "../src/report/ontology.js";
import type { FunctionInfo, RouteInfo } from "../src/ir/types.js";
import { access, backend, call, dto, endpoint, fn, frontend, t } from "./builders.js";

const USER = dto("com.example.UserResponse", { name: t.scalar("String"), profile: t.dto("com.example.Profile"), status: t.enumRef("Status") });
const PROFILE = dto("com.example.Profile", { email: t.scalar("String") });

function func(id: string, file: string, extra: Partial<FunctionInfo> = {}, component: string | null = null): FunctionInfo {
  return { ...fn(id, file, component), ...extra };
}

function route(id: string, path: string | null, componentId: string, component: string): RouteInfo {
  return { id, path, componentId, component, source: "react-router", file: "src/App.tsx", location: { file: "src/App.tsx", line: 5, column: 1 } };
}

/**
 *   /users/:id ─showsComponent─▶ UserPage ─renders─▶ UserCard (reads name, profile.email)
 *                                  └─(effect callback)─calls─▶ getUser ─requests─▶ GET /users/{id}
 *   /orders ─showsComponent─▶ Orders ─requests─▶ GET /orders (not in the backend)
 *   formatDate: a helper on no path to an API
 */
function sample(): Ontology {
  const fns = [
    func("UserPage", "src/pages/User.tsx", { renders: ["UserCard"] }, "UserPage"),
    func("effect", "src/pages/User.tsx", { name: "<anonymous>", parentId: "UserPage", invokes: ["getUser"] }, "UserPage"),
    func("UserCard", "src/components/UserCard.tsx", {}, "UserCard"),
    func("getUser", "src/api/user.ts"),
    func("Orders", "src/pages/Orders.tsx", {}, "Orders"),
    func("formatDate", "src/util.ts"),
  ];
  const calls = [
    call("c1", "GET", "/users/{param}", { callerFunctionId: "getUser", file: "src/api/user.ts" }),
    call("c2", "GET", "/users/{param}", { callerFunctionId: "effect", resolution: "wrapper", wrapperFunctionId: "getUser", file: "src/pages/User.tsx" }),
    call("c3", "GET", "/orders", { callerFunctionId: "Orders", file: "src/pages/Orders.tsx" }),
  ];
  const accesses = [
    access("a1", "c2", ["name"], { containingFunctionId: "UserCard", file: "src/components/UserCard.tsx" }),
    access("a2", "c2", ["profile", "email"], { containingFunctionId: "UserCard", file: "src/components/UserCard.tsx" }),
  ];
  const manifest = {
    ...frontend(calls, accesses, fns),
    routes: [route("r1", "/users/:id", "UserPage", "UserPage"), route("r2", "/orders", "Orders", "Orders")],
  };
  const be = backend(
    [
      endpoint("GET", "/users/{id}", t.dto("com.example.UserResponse"), { handler: "com.example.UserController#getUser" }),
      endpoint("DELETE", "/users/{id}", null, { handler: "com.example.UserController#delete" }),
    ],
    [USER, PROFILE],
  );
  return buildOntology(new ProjectModel(manifest, be));
}

const label = (o: Ontology, id: string) => o.entities.find((e) => e.id === id)?.label ?? id;
const facts = (o: Ontology, predicate?: string) =>
  o.triples.filter((tr) => !predicate || tr.predicate === predicate).map((tr) => `${label(o, tr.subject)} ${tr.predicate} ${label(o, tr.object)}`);

describe("buildOntology", () => {
  it("takes the common-API rule from tacet.config.json", () => {
    const names = Array.from({ length: 10 }, (_, i) => `P${i}`);
    const fns = names.map((n) => func(n, `src/pages/${n}.tsx`, {}, n));
    const calls = names.flatMap((n, i) => [
      call(`auth-${n}`, "GET", "/auth", { callerFunctionId: n, file: `src/pages/${n}.tsx` }),
      call(`item-${n}`, "GET", i < 3 ? "/items" : `/other/${i}`, { callerFunctionId: n, file: `src/pages/${n}.tsx` }),
    ]);
    const manifest = { ...frontend(calls, [], fns), routes: names.map((n) => route(`r-${n}`, `/${n}`, n, n)) };
    const common = (config: object) => {
      const o = buildOntology(new ProjectModel(manifest, null, { commonApis: config }));
      return { rule: o.commonApis, apis: o.entities.filter((e) => e.attributes.common).map((e) => e.label).sort() };
    };
    expect(common({ share: 0.3, minPages: 2 })).toEqual({
      rule: { share: 0.3, minPages: 2, include: [], exclude: [], threshold: 3 },
      apis: ["GET /auth", "GET /items"],
    });
    expect(common({ include: ["GET /other/5"], exclude: ["GET /auth"] }).apis).toEqual(["GET /other/5"]);
    expect(() => common({ share: 2 })).toThrow("commonApis.share");
  });

  it("marks APIs most pages use as common and relates pages by the other APIs they share", () => {
    const names = Array.from({ length: 10 }, (_, i) => `P${i}`);
    const fns = names.map((n) => func(n, `src/pages/${n}.tsx`, {}, n));
    const calls = names.flatMap((n, i) => [
      call(`auth-${n}`, "GET", "/auth", { callerFunctionId: n, file: `src/pages/${n}.tsx` }),
      call(`item-${n}`, "GET", i < 3 ? "/items" : `/other/${i}`, { callerFunctionId: n, file: `src/pages/${n}.tsx` }),
      ...(i < 2 ? [call(`tag-${n}`, "GET", "/tags", { callerFunctionId: n, file: `src/pages/${n}.tsx` })] : []),
    ]);
    const manifest = { ...frontend(calls, [], fns), routes: names.map((n) => route(`r-${n}`, `/${n}`, n, n)) };
    const o = buildOntology(new ProjectModel(manifest, null));
    const auth = o.entities.find((e) => e.label === "GET /auth")!;
    expect(auth.attributes).toMatchObject({ common: true, pages: 10 });
    expect(o.entities.find((e) => e.label === "GET /items")!.attributes).toMatchObject({ common: false, pages: 3 });
    const p0 = o.pages.find((p) => p.route === "/P0")!;
    expect(p0.apis.find((a) => a.apiKey === "GET /auth")!.common).toBe(true);
    expect(p0.related!.map((r) => `${r.route} ${r.shared}`)).toEqual(["/P1 2", "/P2 1"]);
    expect(o.pages.find((p) => p.route === "/P9")!.related).toEqual([]);
  });

  it("does not attribute an API to a page only because a shared helper read its data", () => {
    const fns = [
      func("Orders", "src/pages/Orders.tsx", { invokes: ["formatDate"] }, "Orders"),
      func("formatDate", "src/util.ts"),
      func("UserPage", "src/pages/User.tsx", { invokes: ["formatDate"] }, "UserPage"),
    ];
    const calls = [
      call("c1", "GET", "/users/{param}", { callerFunctionId: "UserPage", file: "src/pages/User.tsx" }),
      call("c2", "GET", "/orders", { callerFunctionId: "Orders", file: "src/pages/Orders.tsx" }),
    ];
    const accesses = [access("a1", "c1", ["name"], { containingFunctionId: "formatDate", file: "src/util.ts" })];
    const manifest = {
      ...frontend(calls, accesses, fns),
      routes: [route("r1", "/users/:id", "UserPage", "UserPage"), route("r2", "/orders", "Orders", "Orders")],
    };
    const o = buildOntology(new ProjectModel(manifest, backend([endpoint("GET", "/users/{id}", t.dto("com.example.UserResponse"))], [USER, PROFILE])));
    const pages = Object.fromEntries(o.pages.map((p) => [p.route, p.apis.map((a) => `${a.apiKey} ${a.fields.join(",")}`)]));
    expect(pages["/orders"]).toEqual(["GET /orders "]);
    expect(pages["/users/:id"]).toEqual(["GET /users/{id} name"]);
  });

  const o = sample();

  it("classifies entities", () => {
    const cls = (l: string) => o.entities.find((e) => e.label === l)?.class;
    expect([cls("/users/:id"), cls("UserPage"), cls("getUser"), cls("GET /users/{id}"), cls("UserController"), cls("UserResponse"), cls("Profile.email"), cls("Status")])
      .toEqual(["Page", "Component", "ApiClient", "Endpoint", "Controller", "Dto", "DtoField", "Enum"]);
  });

  it("folds nested callbacks into their component and links frontend to backend", () => {
    expect(facts(o)).toEqual(expect.arrayContaining([
      "/users/:id showsComponent UserPage",
      "UserPage renders UserCard",
      "UserPage calls getUser",
      "getUser requests GET /users/{id}",
      "UserCard reads UserResponse.name",
      "UserCard reads Profile.email",
      "GET /users/{id} handledBy UserController",
      "GET /users/{id} returns UserResponse",
      "UserResponse hasField UserResponse.profile",
      "UserResponse.profile typedAs Profile",
      "Orders requests GET /orders",
    ]));
    expect(o.entities.some((e) => e.label === "<anonymous>")).toBe(false);
  });

  it("infers which page uses which API, with the path and fields read", () => {
    expect(facts(o, "usesApi").sort()).toEqual(["/orders usesApi GET /orders", "/users/:id usesApi GET /users/{id}"]);
    const users = o.pages.find((p) => p.route === "/users/:id")!;
    expect(users.apis).toEqual([
      expect.objectContaining({ apiKey: "GET /users/{id}", status: "matched", via: ["/users/:id", "UserPage", "getUser", "GET /users/{id}"], fields: ["name", "profile.email"] }),
    ]);
    expect(o.pages.find((p) => p.route === "/orders")!.apis[0].status).toBe("not-found");
    const usesApi = o.triples.find((tr) => tr.predicate === "usesApi" && tr.subject === "page:r1")!;
    expect(usesApi).toMatchObject({ inferred: true, via: ["page:r1", "UserPage", "getUser", "api:GET /users/{id}"] });
  });

  it("drops functions that lead to no API, and keeps evidence", () => {
    expect(o.entities.some((e) => e.label === "formatDate")).toBe(false);
    expect(buildOntology(new ProjectModel(frontend([], [], [func("formatDate", "src/util.ts")]), null), { includeUnrelated: true })
      .entities.some((e) => e.label === "formatDate")).toBe(true);
    const req = o.triples.find((tr) => tr.predicate === "calls" && tr.object === "getUser")!;
    expect(req.evidence).toEqual([{ file: "src/pages/User.tsx", line: 10, code: "call c2" }]);
  });

  it("marks endpoints no frontend code calls as unused", () => {
    expect(o.entities.find((e) => e.label === "DELETE /users/{id}")?.status).toBe("unused");
    expect(pagesByApi(o).find((r) => r.apiKey === "DELETE /users/{id}")?.pages).toEqual([]);
    expect(pagesByApi(o).find((r) => r.apiKey === "GET /users/{id}")?.pages.map((p) => p.route)).toEqual(["/users/:id"]);
  });

  it("can leave out files", () => {
    expect(o.entities.some((e) => e.class === "File")).toBe(true);
    const noFiles = buildOntology(new ProjectModel(frontend([]), null), { includeFiles: false });
    expect(noFiles.triples.some((tr) => tr.predicate === "definedIn")).toBe(false);
  });

  it("focuses on the neighborhood of an entity", () => {
    const focused = focusOntology(o, "/orders", 2);
    expect(focused.entities.map((e) => e.label).sort()).toEqual(expect.arrayContaining(["/orders", "Orders", "GET /orders"]));
    expect(focused.entities.some((e) => e.label === "UserController")).toBe(false);
    expect(focused.pages.map((p) => p.route)).toEqual(["/orders"]);
  });
});

describe("ontology renderers", () => {
  const o = sample();

  it("renders Mermaid with predicate labels and inferred edges dashed", () => {
    const mermaid = renderOntologyMermaid(o);
    expect(mermaid).toMatch(/^flowchart LR/);
    expect(mermaid).toMatch(/-->\|requests\|/);
    expect(mermaid).toMatch(/-\.->\|usesApi\|/);
    expect(mermaid).not.toContain("UserResponse.name");
  });

  it("renders Turtle with the schema and entity IRIs", () => {
    const ttl = renderOntologyTurtle(o);
    expect(ttl).toContain("tacet:usesApi a owl:ObjectProperty");
    expect(ttl).toContain(`<https://tacet.dev/entity/${encodeURIComponent("page:r1")}>`);
    expect(ttl).toContain(`tacet:usesApi <https://tacet.dev/entity/${encodeURIComponent("api:GET /users/{id}")}>`);
  });

  it("renders a self-contained HTML explorer that cannot break out of its data script", () => {
    const html = renderOntologyHtml(o, { title: "</script><b>x" });
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain("Page ↔ API");
  });
});
