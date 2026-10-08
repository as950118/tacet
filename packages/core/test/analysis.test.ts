import { describe, expect, it } from "vitest";
import { checkContract } from "../src/analysis/contract.js";
import { ImpactAnalyzer } from "../src/analysis/impact.js";
import { EndpointLinker } from "../src/analysis/link.js";
import { ProjectModel } from "../src/analysis/model.js";
import { checkPath, describeType, pathsToDto } from "../src/analysis/type-path.js";
import { renderHtml } from "../src/report/html.js";
import { renderMermaid } from "../src/report/mermaid.js";
import { formatAccessPath } from "../src/path.js";
import { access, backend, call, dto, endpoint, fn, frontend, t } from "./builders.js";

const USER = dto("User", {
  name: t.scalar("String"),
  age: [t.scalar("int"), false],
  status: t.enumRef("Status"),
  tags: t.array(t.scalar("String")),
  profile: t.dto("Profile"),
  attributes: t.map(t.scalar("String")),
});
const PROFILE = dto("Profile", { email: t.scalar("String") });
const PAGE = dto("Page", { content: t.array(t.param("T")), total: t.scalar("long") }, ["T"]);
const ENVELOPE = dto("Envelope", { data: t.param("T") }, ["T"]);
const lookup = (dtos = [USER, PROFILE, PAGE, ENVELOPE]) => ({
  dtos: new Map(dtos.map((d) => [d.id, d])),
  enums: new Map([["Status", { id: "Status", name: "Status", values: ["A"], location: { file: "", line: 0, column: 0 } }]]),
});

describe("EndpointLinker", () => {
  const linker = new EndpointLinker([
    endpoint("GET", "/users/{id}", null),
    endpoint("PUT", "/users/{id}", null),
    endpoint("GET", "/users/search", null),
    endpoint("GET", "/products/{id:\\d+}", null),
  ]);

  it.each([
    ["GET", "/users/{param}", "matched", "GET /users/{id}"],
    ["GET", "/users/42", "matched", "GET /users/{id}"],
    ["GET", "/users/search", "matched", "GET /users/search"],
    ["GET", "/products/{param}", "matched", "GET /products/{id:\\d+}"],
    ["PATCH", "/users/{param}", "method-mismatch", null],
    ["GET", "/orders", "not-found", null],
  ] as const)("%s %s -> %s", (method, pattern, status, endpointId) => {
    const link = linker.link(call("c", method, pattern));
    expect(link.status).toBe(status);
    expect(link.endpointId).toBe(endpointId);
  });

  it("lists the methods available on the path for a method mismatch", () => {
    expect(linker.link(call("c", "PATCH", "/users/{param}")).candidates).toEqual(["GET /users/{id}", "PUT /users/{id}"]);
  });

  it("suggests similar endpoints when nothing matches", () => {
    expect(linker.link(call("c", "GET", "/users/{param}/posts")).candidates).toContain("GET /users/{id}");
  });

  it("marks calls without a static URL as unresolved", () => {
    expect(linker.link(call("c", "GET", null)).status).toBe("unresolved");
  });

  it("applies frontend and backend base paths", () => {
    const withBase = new EndpointLinker([endpoint("GET", "/users", null)], {
      frontendBasePath: "/api",
      backendBasePath: "/api",
    });
    expect(withBase.link(call("c", "GET", "/users")).status).toBe("matched");
    expect(withBase.link(call("c", "GET", "/api/users")).status).toBe("matched");
  });

  it("applies proxy/gateway path rewrites, longest prefix first", () => {
    const gateway = new EndpointLinker([endpoint("GET", "/admin/v1/users", null), endpoint("GET", "/v1/login", null)], {
      pathRewrites: { "/api": "", "/api/console": "" },
    });
    expect(gateway.link(call("c", "GET", "/api/console/admin/v1/users")).endpointId).toBe("GET /admin/v1/users");
    expect(gateway.link(call("c", "GET", "/api/v1/login")).endpointId).toBe("GET /v1/login");
    expect(gateway.link(call("c", "GET", "/apiv1/login")).status).toBe("not-found");
  });
});

describe("checkPath", () => {
  const check = (root: ReturnType<typeof t.dto>, path: string[]) => checkPath(root, path, lookup());

  it("accepts existing nested fields, array elements, map values and string length", () => {
    expect(check(t.dto("User"), ["profile", "email"]).status).toBe("ok");
    expect(check(t.array(t.dto("User")), ["[]", "tags", "[]"]).status).toBe("ok");
    expect(check(t.dto("User"), ["attributes", "color"]).status).toBe("ok");
    expect(check(t.dto("User"), ["name", "length"]).status).toBe("ok");
    expect(check(t.dto("User"), ["tags", "length"]).status).toBe("ok");
  });

  it("substitutes generic type arguments", () => {
    expect(check(t.dto("Page", t.dto("User")), ["content", "[]", "name"]).status).toBe("ok");
    expect(check(t.dto("Envelope", t.dto("Page", t.dto("User"))), ["data", "content", "[]", "age"]).status).toBe("ok");
    expect(check(t.dto("Page", t.dto("User")), ["content", "[]", "nmae"])).toMatchObject({
      status: "missing",
      at: 2,
      reason: "no-such-field",
      parentType: "User",
    });
  });

  it("reports missing fields with the available alternatives", () => {
    expect(check(t.dto("User"), ["nickname"])).toMatchObject({
      status: "missing",
      reason: "no-such-field",
      available: ["name", "age", "status", "tags", "profile", "attributes"],
    });
  });

  it("detects array/object shape mismatches", () => {
    expect(check(t.dto("User"), ["[]", "name"])).toMatchObject({ reason: "not-an-array" });
    expect(check(t.array(t.dto("User")), ["name"])).toMatchObject({ reason: "not-an-object" });
    expect(check(t.dto("User"), ["status", "label"])).toMatchObject({ reason: "not-an-object" });
    expect(check(t.dto("User"), ["age", "value"])).toMatchObject({ reason: "not-an-object" });
  });

  it("does not guess through unknown types", () => {
    expect(checkPath(t.unknown("JsonNode"), ["a"], lookup())).toMatchObject({ status: "unverifiable" });
    expect(checkPath(t.dto("Envelope"), ["data", "x"], lookup())).toMatchObject({ status: "unverifiable", typeName: "T" });
  });

  it("describes types", () => {
    expect(describeType(t.dto("Envelope", t.array(t.dto("User"))), lookup())).toBe("Envelope<User[]>");
  });

  it("finds where a DTO appears in a response", () => {
    expect(pathsToDto(t.dto("Envelope", t.dto("Page", t.dto("User"))), "User", lookup())).toEqual([
      ["data", "content", "[]"],
    ]);
    expect(pathsToDto(t.dto("User"), "Profile", lookup())).toEqual([["profile"]]);
  });

  it("formats access paths", () => {
    expect(formatAccessPath(["content", "[]", "name"])).toBe("content[].name");
    expect(formatAccessPath(["[]", "name"])).toBe("[].name");
  });
});

function sampleModel() {
  const be = backend(
    [
      endpoint("GET", "/users/{id}", t.dto("User")),
      endpoint("GET", "/users", t.dto("Page", t.dto("User")), {
        requestParams: [
          { name: "keyword", type: t.scalar("String"), required: false, source: "query" },
          { name: "tenant", type: t.scalar("String"), required: true, source: "query" },
        ],
      }),
      endpoint("POST", "/users", t.dto("User"), {
        requestBody: { type: t.dto("CreateUser"), required: true },
      }),
      endpoint("DELETE", "/users/{id}", null),
      endpoint("GET", "/unused", null),
    ],
    [USER, PROFILE, PAGE, dto("CreateUser", { name: [t.scalar("String"), false], email: t.scalar("String") })],
  );
  const fe = frontend(
    [
      call("c:wrapper", "GET", "/users/{param}", { file: "src/api.ts", callerFunctionId: "getUser" }),
      call("c:page", "GET", "/users/{param}", {
        file: "src/Page.tsx",
        callerFunctionId: "Page",
        resolution: "wrapper",
        wrapperFunctionId: "getUser",
      }),
      call("c:list", "GET", "/users", { file: "src/List.tsx", request: { queryKeys: ["keyword", "size"], bodyKeys: [] } }),
      call("c:create", "POST", "/users", { file: "src/List.tsx", request: { queryKeys: [], bodyKeys: ["name", "nickname"] } }),
      call("c:delete", "DELETE", "/users/{param}", { file: "src/List.tsx" }),
      call("c:orders", "GET", "/orders", { file: "src/Orders.tsx" }),
      call("c:dynamic", "GET", null, { file: "src/Orders.tsx", calleeExpression: "axios.get" }),
    ],
    [
      access("a:name", "c:page", ["name"], { file: "src/Page.tsx", containingFunctionId: "Page", containingComponent: "Page" }),
      access("a:email", "c:page", ["profile", "email"], { file: "src/Card.tsx", containingFunctionId: "Card", containingComponent: "Card" }),
      access("a:typo", "c:page", ["nmae"], { file: "src/Card.tsx", containingFunctionId: "Card", containingComponent: "Card" }),
      access("a:derived", "c:page", ["missing"], { file: "src/Page.tsx", flow: "derived" }),
      access("a:list", "c:list", ["content", "[]", "name"], { file: "src/List.tsx" }),
      access("a:delete", "c:delete", ["id"], { file: "src/List.tsx" }),
      access("a:orders", "c:orders", ["items"], { file: "src/Orders.tsx" }),
    ],
    [fn("getUser", "src/api.ts"), fn("Page", "src/Page.tsx", "Page"), fn("Card", "src/Card.tsx", "Card")],
    [
      { path: "src/api.ts", imports: [], exports: ["getUser"] },
      { path: "src/Page.tsx", imports: [{ source: "./api", resolvedFile: "src/api.ts", specifiers: ["getUser"], location: { file: "src/Page.tsx", line: 1, column: 1 } }], exports: [] },
      { path: "src/Card.tsx", imports: [], exports: [] },
      { path: "src/App.tsx", imports: [{ source: "./Page", resolvedFile: "src/Page.tsx", specifiers: ["Page"], location: { file: "src/App.tsx", line: 1, column: 1 } }], exports: [] },
      { path: "src/List.tsx", imports: [], exports: [] },
      { path: "src/Orders.tsx", imports: [], exports: [] },
    ],
  );
  return new ProjectModel(fe, be);
}

describe("checkContract", () => {
  it("reports every kind of contract violation", () => {
    const report = checkContract(sampleModel());
    expect(report.result).toBe("FAIL");
    expect(report.issues.map((i) => `${i.severity} ${i.code} ${i.file}`)).toEqual([
      "error FIELD_NOT_FOUND src/Card.tsx",
      "error NO_RESPONSE_BODY src/List.tsx",
      "error ENDPOINT_NOT_FOUND src/Orders.tsx",
      "warning UNKNOWN_QUERY_PARAM src/List.tsx",
      "warning MISSING_QUERY_PARAM src/List.tsx",
      "warning UNKNOWN_BODY_FIELD src/List.tsx",
      "warning FIELD_NOT_FOUND src/Page.tsx",
      "info UNRESOLVED_ENDPOINT src/Orders.tsx",
    ]);
    expect(report.counts).toEqual({ error: 3, warning: 4, info: 1 });
  });

  it("does not fail an alternative of a fallback chain when another alternative exists", () => {
    const base = sampleModel();
    const fe = {
      ...base.frontend,
      propertyAccesses: [
        access("a:ok", "c:page", ["name"], { file: "src/Fallback.tsx", fallbackGroup: "g1" }),
        access("a:alt", "c:page", ["full_name"], { file: "src/Fallback.tsx", fallbackGroup: "g1" }),
        access("a:none1", "c:page", ["nick"], { file: "src/Fallback.tsx", fallbackGroup: "g2" }),
        access("a:none2", "c:page", ["nick_name"], { file: "src/Fallback.tsx", fallbackGroup: "g2" }),
      ],
    };
    const report = checkContract(new ProjectModel(fe, base.backend!), { files: ["src/Fallback.tsx"] });
    expect(report.issues.map((i) => `${i.accessId} ${i.severity} ${i.code}`)).toEqual([
      "a:none1 error FIELD_NOT_FOUND",
      "a:none2 error FIELD_NOT_FOUND",
      "a:alt info FALLBACK_FIELD_NOT_FOUND",
    ]);
  });

  it("suggests the closest field name", () => {
    const typo = checkContract(sampleModel()).issues.find((i) => i.accessId === "a:typo")!;
    expect(typo.suggestion).toBe("Did you mean `name`?");
    expect(typo.message).toContain("User has no field `nmae`");
  });

  it("scopes to the APIs a changed file uses, including reads of calls made elsewhere", () => {
    const report = checkContract(sampleModel(), { files: ["src/Card.tsx"] });
    expect(report.apis.map((a) => a.apiKey)).toEqual(["GET /users/{id}"]);
    expect(report.issues.map((i) => i.accessId)).toEqual(["a:typo"]);
  });

  it("checks every read when the calling file changes", () => {
    const report = checkContract(sampleModel(), { files: ["src/Page.tsx"] });
    expect(report.issues.map((i) => i.accessId).sort()).toEqual(["a:derived", "a:typo"]);
  });

  it("passes when everything matches", () => {
    const model = sampleModel();
    const report = checkContract(model, { files: ["src/api.ts"] });
    expect(report.result).toBe("PASS");
  });

  it("requires a backend", () => {
    expect(() => checkContract(new ProjectModel(frontend([]), null))).toThrow("no backend manifest");
  });
});

describe("ImpactAnalyzer", () => {
  const analyzer = () => new ImpactAnalyzer(sampleModel());

  it("finds every call site and field read of an API", () => {
    const [impact] = analyzer().impactOfApi("GET /users/:id");
    expect(impact.apiKey).toBe("GET /users/{id}");
    expect(impact.callSites.map((c) => `${c.file} via ${c.via}`)).toEqual(["src/api.ts via null", "src/Page.tsx via getUser"]);
    expect(impact.fields.map((f) => f.path)).toEqual(["missing", "name", "nmae", "profile.email"]);
    expect(impact.files).toEqual(["src/Card.tsx", "src/Page.tsx", "src/api.ts"]);
    expect(impact.components).toEqual(["Card", "Page"]);
  });

  it("matches a path without method against every method", () => {
    expect(analyzer().impactOfApi("/users/{id}").map((i) => i.apiKey)).toEqual(["DELETE /users/{id}", "GET /users/{id}"]);
  });

  it("describes the blast radius of changing a file", () => {
    const impact = analyzer().impactOfFile("src/api.ts");
    expect(impact.clientFunctions).toEqual([
      expect.objectContaining({ name: "getUser", apiKeys: ["GET /users/{id}"], callSites: [expect.objectContaining({ file: "src/Page.tsx" })] }),
    ]);
    expect(impact.dependents).toEqual(["src/App.tsx", "src/Page.tsx"]);
    expect(impact.blastRadius.files).toEqual(["src/Card.tsx", "src/Page.tsx", "src/api.ts"]);
  });

  it("lists APIs whose response a file only reads", () => {
    const impact = analyzer().impactOfFile("src/Card.tsx");
    expect(impact.apis.map((a) => `${a.apiKey} ${a.via.join("+")}`)).toEqual(["GET /users/{id} read"]);
  });

  it("finds reads of a DTO field through every endpoint returning it", () => {
    const [impact] = analyzer().impactOfField("User.name");
    expect(impact.usages.map((u) => `${u.apiKey} ${u.responsePath} ${u.reads.length}`)).toEqual([
      "GET /users/{id} name 1",
      "GET /users content[].name 1",
      "POST /users name 0",
    ]);
    expect(analyzer().impactOfField("Profile.email")[0].files).toEqual(["src/Card.tsx"]);
  });

  it("searches across APIs, files, functions and DTO fields", () => {
    const kinds = analyzer().search("user").map((h) => `${h.kind}:${h.label}`);
    expect(kinds).toEqual(expect.arrayContaining(["api:GET /users/{id}", "function:getUser", "dto:User"]));
    expect(analyzer().search("email").map((h) => h.label)).toEqual(["Profile.email", "CreateUser.email"]);
  });

  it("ranks APIs by impact and lists unused endpoints", () => {
    const summary = analyzer().summary();
    expect(summary.apis[0]).toMatchObject({ apiKey: "GET /users/{id}", files: 3 });
    expect(summary.unusedEndpoints).toEqual(["GET /unused"]);
    expect(summary.apis.find((a) => a.apiKey === "GET /orders")?.status).toBe("not-found");
  });

  it("builds a graph from API through client function to component and file", () => {
    const graph = analyzer().impactOfApi("GET /users/{id}")[0].graph;
    const edges = graph.edges.map((e) => `${e.from} -${e.kind}-> ${e.to}`);
    expect(edges).toEqual(
      expect.arrayContaining([
        "api:GET /users/{id} -calls-> getUser",
        "getUser -calls-> Page",
        "Page -defined-in-> file:src/Page.tsx",
        "api:GET /users/{id} -has-field-> field:GET /users/{id}#profile.email",
        "field:GET /users/{id}#profile.email -reads-> Card",
      ]),
    );
    const api = graph.nodes.find((n) => n.id === "api:GET /users/{id}")!;
    expect(api.impact).toBe(3);
    expect(graph.nodes.find((n) => n.id === "Card")?.kind).toBe("component");
  });

  it("includes unused endpoints in the full graph", () => {
    const graph = analyzer().fullGraph();
    expect(graph.nodes.find((n) => n.id === "api:GET /unused")?.status).toBe("unused");
  });
});

describe("renderers", () => {
  const graph = new ImpactAnalyzer(sampleModel()).fullGraph();

  it("renders Mermaid", () => {
    const mermaid = renderMermaid(graph);
    expect(mermaid.startsWith("flowchart LR")).toBe(true);
    expect(mermaid).toContain('[["GET /users/{id} · 3 files"]]');
    expect(mermaid).toMatch(/class .* broken/);
  });

  it("renders a self-contained HTML page with escaped data", () => {
    const html = renderHtml(
      { nodes: [{ ...graph.nodes[0], label: "</script><img src=x onerror=alert(1)>" }], edges: [] },
      { title: "<Impact>" },
    );
    expect(html).toContain("<title>&lt;Impact&gt;</title>");
    expect(html).not.toContain("</script><img");
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});
