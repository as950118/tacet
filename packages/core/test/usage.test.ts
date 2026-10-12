import { describe, expect, it } from "vitest";
import { forwardedPatterns, routesTo } from "../src/analysis/gateway.js";
import { EndpointLinker } from "../src/analysis/link.js";
import { ProjectModel } from "../src/analysis/model.js";
import { analyzeUsage } from "../src/analysis/usage.js";
import type { GatewayRouteInfo } from "../src/ir/types.js";
import { renderUsageCsv, renderUsageMarkdown } from "../src/report/usage.js";
import { backend, call, endpoint, frontend, serviceCall } from "./builders.js";

const loc = { file: "routes.yml", line: 1, column: 1 };
const route = (id: string, paths: string[], extra: Partial<GatewayRouteInfo> = {}): GatewayRouteInfo => ({
  id,
  uri: "lb://svc",
  paths,
  rewrites: [],
  stripPrefix: 0,
  prefixPath: null,
  location: loc,
  ...extra,
});

describe("EndpointLinker.linkServiceCall", () => {
  const linker = new EndpointLinker([endpoint("GET", "/{userType:admin|user}/v1/users/{id}", null)]);

  it("matches a client path after removing the target's context path", () => {
    const link = linker.linkServiceCall(serviceCall("GET", "/api/user/v1/users/{userId}"), ["/api"]);
    expect(link).toMatchObject({ status: "matched", endpointId: "GET /{userType:admin|user}/v1/users/{id}" });
  });

  it("reports a method mismatch and leaves calls to other systems unmatched", () => {
    expect(linker.linkServiceCall(serviceCall("DELETE", "/api/user/v1/users/1"), ["/api"]).status).toBe("method-mismatch");
    expect(linker.linkServiceCall(serviceCall("GET", "/api/v1/query"), ["/api"]).status).toBe("not-found");
  });
});

describe("gateway routes", () => {
  it("follows RewritePath (with YAML-escaped placeholders) and the context path", () => {
    const patterns = forwardedPatterns(
      [route("admin", ["/api/console/admin/**"], { rewrites: [{ regex: "/api/console/admin/(?<segment>.*)", replacement: "/api/admin/$\\{segment}" }] })],
      ["/api"],
    );
    expect(patterns.map((p) => p.pattern)).toEqual(["/admin/**"]);
    expect(routesTo(endpoint("GET", "/admin/v1/users", null), patterns)).toEqual(["admin"]);
    expect(routesTo(endpoint("GET", "/{userType:admin|user}/v1/users", null), patterns)).toEqual(["admin"]);
    expect(routesTo(endpoint("GET", "/common/v1/info", null), patterns)).toEqual([]);
  });

  it("respects path variable constraints", () => {
    const patterns = forwardedPatterns([route("custom", ["/custom-be/**"])]);
    expect(routesTo(endpoint("GET", "/{userType:admin|user}/v1/users", null), patterns)).toEqual([]);
    expect(routesTo(endpoint("GET", "/{tenant}/v1/users", null), patterns)).toEqual(["custom"]);
  });

  it("applies StripPrefix and PrefixPath, and matches exact paths exactly", () => {
    const patterns = forwardedPatterns([
      route("shop", ["/shop/products/**"], { stripPrefix: 1, prefixPath: "/api" }),
      route("health", ["/health"]),
    ], ["/api"]);
    expect(patterns.map((p) => p.pattern)).toEqual(["/products/**", "/health"]);
    expect(routesTo(endpoint("GET", "/products/{id}", null), patterns)).toEqual(["shop"]);
    expect(routesTo(endpoint("GET", "/health/deep", null), patterns)).toEqual([]);
  });
});

describe("analyzeUsage", () => {
  const be = {
    ...backend([
      endpoint("GET", "/users", null, { handler: "com.example.UserController#list" }),
      endpoint("DELETE", "/users", null, { handler: "com.example.UserController#clear" }),
      endpoint("GET", "/users/{id}", null, { handler: "com.example.UserController#get" }),
      endpoint("POST", "/users/sync", null, { handler: "com.example.UserController#sync" }),
      endpoint("GET", "/internal/stats", null, { handler: "com.example.StatsController#stats" }),
    ]),
    serviceCalls: [
      serviceCall("GET", "/api/users/{id}"),
      serviceCall("POST", "/api/users/sync", { handler: "com.example.UserClient#sync", referenced: false }),
      serviceCall("GET", "/api/v1/query", { handler: "com.example.MetricsClient#query" }),
    ],
    gatewayRoutes: [route("users", ["/gw/users/**"], { rewrites: [{ regex: "/gw/(?<s>.*)", replacement: "/api/${s}" }] })],
    contextPaths: ["/api"],
  };
  const admin = new ProjectModel(frontend([call("c1", "GET", "/users")]), be);
  const user = new ProjectModel(frontend([call("c2", "GET", "/users"), call("c3", "GET", null)]), be);
  const report = analyzeUsage([
    { name: "admin", model: admin },
    { name: "user", model: user },
  ]);
  const usage = (id: string) => report.endpoints.find((e) => e.endpoint === id)!;

  it("classifies each endpoint by its callers", () => {
    expect(usage("GET /users")).toMatchObject({ usage: "frontend", frontends: [{ frontend: "admin", calls: 1 }, { frontend: "user", calls: 1 }] });
    expect(usage("GET /users/{id}")).toMatchObject({ usage: "service", services: [{ client: "com.example.UserClient" }] });
    expect(usage("POST /users/sync").usage).toBe("client-declared");
    expect(usage("DELETE /users")).toMatchObject({ usage: "unused", otherMethodsUsed: ["GET"], routes: ["users"] });
    expect(usage("GET /internal/stats")).toMatchObject({ usage: "unused", routes: [] });
    expect(report.totals).toEqual({ endpoints: 5, frontend: 1, service: 1, clientDeclared: 1, unused: 2, unusedNotRouted: 1 });
  });

  it("reports what it cannot see", () => {
    expect(report.frontends.map((f) => [f.name, f.unresolvedCalls])).toEqual([["admin", 0], ["user", 1]]);
    expect(report.externalServiceCalls.map((c) => c.handler)).toEqual(["com.example.MetricsClient#query"]);
  });

  it("renders unused endpoints as CSV and markdown", () => {
    const csv = renderUsageCsv(report).trim().split("\n");
    expect(csv).toHaveLength(4);
    const sync = csv.find((row) => row.startsWith("client-declared,POST,/users/sync,UserController"));
    expect(sync).toContain("UserClient#sync (never called)");
    const md = renderUsageMarkdown(report);
    expect(md).toContain("## Controllers with no used endpoint (1)");
    expect(md).toContain("| StatsController | 1 |");
    expect(md).toContain("`DELETE /users` Controller.java:1 — GET on this path is used");
    expect(md).toContain("user: 1 of 2 API calls have URLs Tacet could not resolve.");
  });

  it("needs a backend", () => {
    expect(() => analyzeUsage([{ name: "x", model: new ProjectModel(frontend([]), null) }])).toThrow(/extract-backend/);
  });
});
