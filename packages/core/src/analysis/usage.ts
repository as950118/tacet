import type { BackendManifest, EndpointInfo, ServiceCallInfo, SourceLocation } from "../ir/types.js";
import { normalizePath } from "../path.js";
import { forwardedPatterns, routesTo } from "./gateway.js";
import type { ProjectModel } from "./model.js";

/**
 * - frontend:        a frontend calls it
 * - service:         another backend service calls it (Feign / @HttpExchange client method that is used)
 * - client-declared: only a client method nobody calls points at it
 * - unused:          no caller found
 */
export type EndpointUsageKind = "frontend" | "service" | "client-declared" | "unused";

export interface FrontendUse {
  frontend: string;
  calls: number;
  /** Files with the calls, at most 5. */
  files: string[];
}

export interface ServiceUse {
  serviceCall: string;
  client: string;
  handler: string;
  target: string | null;
  referenced: boolean;
  location: SourceLocation;
}

export interface EndpointUsage {
  endpoint: string;
  method: EndpointInfo["method"];
  path: string;
  handler: string;
  /** The controller class, e.g. "com.example.user.UserController". */
  controller: string;
  location: SourceLocation;
  usage: EndpointUsageKind;
  frontends: FrontendUse[];
  services: ServiceUse[];
  /** Other methods on the same path that something calls (e.g. GET is used, DELETE is not). */
  otherMethodsUsed: string[];
  /** Gateway routes forwarding to it; null when the backend declares no gateway routes. */
  routes: string[] | null;
}

export interface UsageTotals {
  endpoints: number;
  frontend: number;
  service: number;
  clientDeclared: number;
  unused: number;
  /** Unused endpoints no gateway route reaches: internal-only, or reached from outside the repository. */
  unusedNotRouted: number;
}

export interface FrontendSummary {
  name: string;
  rootDir: string;
  apiCalls: number;
  /** Calls whose URL could not be determined statically: they may use endpoints reported unused. */
  unresolvedCalls: number;
}

export interface UsageReport {
  frontends: FrontendSummary[];
  backendRootDir: string;
  /** Feign / @HttpExchange clients found, and whether gateway routes were found: what the report can see. */
  serviceCalls: number;
  gatewayRoutes: number;
  totals: UsageTotals;
  endpoints: EndpointUsage[];
  /** Service calls to endpoints outside this backend (other systems, e.g. a metrics server). */
  externalServiceCalls: ServiceCallInfo[];
}

export interface UsageInput {
  /** Shown in the report, e.g. "admin". */
  name: string;
  model: ProjectModel;
}

/**
 * Who uses each backend endpoint: the frontends (one model per frontend index, all against the same backend),
 * other services through declarative HTTP clients, and whether a gateway route exposes it.
 */
export function analyzeUsage(inputs: UsageInput[]): UsageReport {
  const primary = inputs[0]?.model;
  const backend: BackendManifest | null = primary?.backend ?? null;
  if (!primary || !backend) throw new Error("Usage analysis needs a backend: run `tacet extract-backend` first.");

  const frontendUses = new Map<string, Map<string, { calls: number; files: Set<string> }>>();
  const pathsUsed = new Map<string, Set<string>>();
  const markPath = (path: string, method: string): void => {
    const methods = pathsUsed.get(path) ?? new Set<string>();
    methods.add(method);
    pathsUsed.set(path, methods);
  };
  const frontends: FrontendSummary[] = [];
  for (const { name, model } of inputs) {
    let unresolved = 0;
    for (const call of model.frontend.apiCalls) {
      const link = model.link(call.id);
      if (!link || link.status === "unresolved") unresolved++;
      if (link?.status !== "matched" || !link.endpointId) continue;
      const byFrontend = frontendUses.get(link.endpointId) ?? new Map();
      const use = byFrontend.get(name) ?? { calls: 0, files: new Set<string>() };
      use.calls++;
      use.files.add(call.file);
      byFrontend.set(name, use);
      frontendUses.set(link.endpointId, byFrontend);
    }
    frontends.push({ name, rootDir: model.frontend.rootDir, apiCalls: model.frontend.apiCalls.length, unresolvedCalls: unresolved });
  }

  const serviceUses = new Map<string, ServiceUse[]>();
  const externalServiceCalls: ServiceCallInfo[] = [];
  for (const call of backend.serviceCalls ?? []) {
    const link = primary.serviceLinks.get(call.id);
    if (link?.status !== "matched" || !link.endpointId) {
      externalServiceCalls.push(call);
      continue;
    }
    const list = serviceUses.get(link.endpointId) ?? [];
    list.push({
      serviceCall: call.id,
      client: call.client,
      handler: call.handler,
      target: call.target,
      referenced: call.referenced,
      location: call.location,
    });
    serviceUses.set(link.endpointId, list);
  }

  const usageOf = (endpoint: EndpointInfo): EndpointUsageKind => {
    if (frontendUses.has(endpoint.id)) return "frontend";
    const services = serviceUses.get(endpoint.id) ?? [];
    if (services.some((s) => s.referenced)) return "service";
    return services.length > 0 ? "client-declared" : "unused";
  };
  for (const endpoint of backend.endpoints) {
    const usage = usageOf(endpoint);
    if (usage === "frontend" || usage === "service") markPath(normalizePath(endpoint.path), endpoint.method);
  }

  const routes = backend.gatewayRoutes ?? [];
  const patterns = forwardedPatterns(routes, backend.contextPaths);
  const backendBasePath = primary.config.linking?.backendBasePath;
  const endpoints = backend.endpoints.map((endpoint): EndpointUsage => {
    const path = normalizePath(endpoint.path);
    return {
      endpoint: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      handler: endpoint.handler,
      controller: endpoint.handler.split("#")[0],
      location: endpoint.location,
      usage: usageOf(endpoint),
      frontends: [...(frontendUses.get(endpoint.id) ?? new Map()).entries()].map(([frontend, use]) => ({
        frontend,
        calls: use.calls,
        files: [...use.files].sort().slice(0, 5),
      })),
      services: serviceUses.get(endpoint.id) ?? [],
      otherMethodsUsed: [...(pathsUsed.get(path) ?? [])].filter((m) => m !== endpoint.method).sort(),
      routes: routes.length > 0 ? routesTo(endpoint, patterns, backendBasePath) : null,
    };
  });

  const count = (kind: EndpointUsageKind): number => endpoints.filter((e) => e.usage === kind).length;
  return {
    frontends,
    backendRootDir: backend.rootDir,
    serviceCalls: backend.serviceCalls?.length ?? 0,
    gatewayRoutes: routes.length,
    totals: {
      endpoints: endpoints.length,
      frontend: count("frontend"),
      service: count("service"),
      clientDeclared: count("client-declared"),
      unused: count("unused"),
      unusedNotRouted: endpoints.filter((e) => e.usage === "unused" && e.routes !== null && e.routes.length === 0).length,
    },
    endpoints,
    externalServiceCalls,
  };
}
