import type { ApiCallInfo, EndpointInfo, FunctionInfo, RouteInfo, TypeRef } from "../ir/types.js";
import type { CommonApisConfig } from "../config.js";
import { formatAccessPath } from "../path.js";
import type { ApiUsage } from "./impact.js";
import type { ProjectModel } from "./model.js";
import { checkPath, describeType } from "./type-path.js";

export type OntologyClass =
  | "Page"
  | "Component"
  | "Hook"
  | "ApiClient"
  | "Function"
  | "Endpoint"
  | "Controller"
  | "Dto"
  | "DtoField"
  | "Enum"
  | "File";

export type OntologyPredicate =
  | "showsComponent"
  | "renders"
  | "calls"
  | "requests"
  | "reads"
  | "usesApi"
  | "handledBy"
  | "accepts"
  | "returns"
  | "hasField"
  | "typedAs"
  | "definedIn";

export interface OntologyEntity {
  id: string;
  class: OntologyClass;
  label: string;
  detail: string | null;
  file: string | null;
  line: number | null;
  /** Endpoints: link status of the frontend calls, or "unused" when no frontend code calls it. */
  status: ApiUsage["status"] | null;
  attributes: Record<string, string | number | boolean | null>;
}

export interface OntologyEvidence {
  file: string;
  line: number;
  code: string;
}

export interface OntologyTriple {
  subject: string;
  predicate: OntologyPredicate;
  object: string;
  /** Derived from other triples (usesApi), not read directly from code. */
  inferred: boolean;
  evidence: OntologyEvidence[];
  /** usesApi: the entity ids on the path from the page to the endpoint, both ends included. */
  via?: string[];
}

export interface OntologyClassInfo {
  name: OntologyClass;
  description: string;
}

export interface OntologyPredicateInfo {
  name: OntologyPredicate;
  domain: OntologyClass[];
  range: OntologyClass[];
  inferred: boolean;
  description: string;
}

export interface OntologySchema {
  classes: OntologyClassInfo[];
  predicates: OntologyPredicateInfo[];
}

export interface PageApiUse {
  /** Endpoint entity id. */
  endpoint: string;
  apiKey: string;
  status: OntologyEntity["status"];
  /** Labels on the path from the page to the API, e.g. ["/users/:id", "UserPage", "getUser", "GET /users/{id}"]. */
  via: string[];
  /** Response fields the page (or a component it renders) reads. */
  fields: string[];
  /** A common API (used by a large share of all pages, e.g. a permission check or an icon fetch). */
  common?: boolean;
}

/** Another page that uses some of the same APIs (common APIs left out). */
export interface RelatedPage {
  page: string;
  route: string | null;
  component: string;
  /** How many (non-common) APIs both pages use. */
  shared: number;
  /** Those APIs, at most 10. */
  apis: string[];
}

export interface PageApis {
  /** Page entity id. */
  page: string;
  route: string | null;
  component: string;
  file: string;
  apis: PageApiUse[];
  /** Pages sharing the most (non-common) APIs with this one, at most 8. */
  related?: RelatedPage[];
}

export interface Ontology {
  schema: OntologySchema;
  entities: OntologyEntity[];
  triples: OntologyTriple[];
  /** Page → API matrix (the usesApi triples, with the fields each page reads). */
  pages: PageApis[];
  stats: { entities: Partial<Record<OntologyClass, number>>; triples: number; inferred: number };
  /** The common-API rule the ontology was built with (project defaults from tacet.config.json). */
  commonApis?: CommonApiRule;
  /** Frontend root; identifies the project (e.g. for settings a viewer keeps in the browser). */
  rootDir?: string;
}

export interface CommonApiRule {
  share: number;
  minPages: number;
  include: string[];
  exclude: string[];
  /** Pages an API needs to be common: max(minPages, ceil(share × pages)). */
  threshold: number;
}

export interface OntologyOptions {
  /** Include File entities and definedIn triples (default true). */
  includeFiles?: boolean;
  /** Keep frontend functions with no path to any API (default false). */
  includeUnrelated?: boolean;
}

export const ONTOLOGY_SCHEMA: OntologySchema = {
  classes: [
    { name: "Page", description: "A route of the frontend (or a page component found by convention)" },
    { name: "Component", description: "A React component" },
    { name: "Hook", description: "A React hook (use*)" },
    { name: "ApiClient", description: "A frontend function that sends an HTTP request" },
    { name: "Function", description: "Any other frontend function on a path to an API" },
    { name: "Endpoint", description: "A backend API (method + path), or what the frontend requests when unmatched" },
    { name: "Controller", description: "The backend class handling endpoints" },
    { name: "Dto", description: "A request or response type of the backend" },
    { name: "DtoField", description: "A JSON field of a DTO" },
    { name: "Enum", description: "A backend enum used in DTOs" },
    { name: "File", description: "A source file" },
  ],
  predicates: [
    { name: "showsComponent", domain: ["Page"], range: ["Component", "Function"], inferred: false, description: "The route renders this component" },
    { name: "renders", domain: ["Component", "Function", "Hook"], range: ["Component"], inferred: false, description: "Renders the component as a JSX element" },
    { name: "calls", domain: ["Component", "Hook", "ApiClient", "Function"], range: ["Hook", "ApiClient", "Function"], inferred: false, description: "Calls the function" },
    { name: "requests", domain: ["Component", "Hook", "ApiClient", "Function"], range: ["Endpoint"], inferred: false, description: "Sends an HTTP request to the endpoint" },
    { name: "reads", domain: ["Component", "Hook", "ApiClient", "Function"], range: ["DtoField", "Endpoint"], inferred: false, description: "Reads this response field (the endpoint when the field cannot be resolved)" },
    { name: "usesApi", domain: ["Page"], range: ["Endpoint"], inferred: true, description: "The page requests the API, or shows its data, through the components and functions it uses" },
    { name: "handledBy", domain: ["Endpoint"], range: ["Controller"], inferred: false, description: "Handled by the controller" },
    { name: "accepts", domain: ["Endpoint"], range: ["Dto", "Enum"], inferred: false, description: "Request body type" },
    { name: "returns", domain: ["Endpoint"], range: ["Dto", "Enum"], inferred: false, description: "Response type (including generic arguments)" },
    { name: "hasField", domain: ["Dto"], range: ["DtoField"], inferred: false, description: "JSON field of the DTO" },
    { name: "typedAs", domain: ["DtoField"], range: ["Dto", "Enum"], inferred: false, description: "The field holds this DTO or enum" },
    { name: "definedIn", domain: ["Page", "Component", "Hook", "ApiClient", "Function", "Controller", "Dto", "Enum"], range: ["File"], inferred: false, description: "Declared in the file" },
  ],
};

const MAX_EVIDENCE = 5;

/**
 * Builds a typed view of the project: pages, components, functions, endpoints, controllers and DTOs as
 * entities, and how they connect as subject–predicate–object triples. `usesApi` answers "which page uses
 * which API": it follows showsComponent / renders / calls / requests from every page, plus the response
 * fields the visited code reads.
 */
export function buildOntology(model: ProjectModel, options: OntologyOptions = {}): Ontology {
  const includeFiles = options.includeFiles ?? true;
  const entities = new Map<string, OntologyEntity>();
  const triples = new Map<string, OntologyTriple>();
  const lookup = { dtos: model.dtos, enums: model.enums };

  const entity = (e: Omit<OntologyEntity, "attributes"> & { attributes?: OntologyEntity["attributes"] }): string => {
    if (!entities.has(e.id)) entities.set(e.id, { ...e, attributes: e.attributes ?? {} });
    return e.id;
  };
  const triple = (subject: string, predicate: OntologyPredicate, object: string, evidence?: OntologyEvidence): void => {
    if (subject === object) return;
    const key = `${subject}\u0000${predicate}\u0000${object}`;
    const t = triples.get(key) ?? triples.set(key, { subject, predicate, object, inferred: false, evidence: [] }).get(key)!;
    if (evidence && t.evidence.length < MAX_EVIDENCE && !t.evidence.some((e) => e.file === evidence.file && e.line === evidence.line)) {
      t.evidence.push(evidence);
    }
  };
  const fileEntity = (side: "frontend" | "backend", path: string): string =>
    entity({ id: `file:${side}:${path}`, class: "File", label: path, detail: side, file: path, line: null, status: null, attributes: { side } });

  // ------------------------------------------------------------------ frontend

  // Nested functions (callbacks, local helpers) are folded into the module-level function containing them.
  const outermost = new Map<string, FunctionInfo>();
  const ownerOf = (id: string | null): FunctionInfo | null => {
    if (!id) return null;
    const cached = outermost.get(id);
    if (cached) return cached;
    let fn = model.functions.get(id);
    const seen = new Set<string>();
    while (fn?.parentId && !seen.has(fn.id)) {
      seen.add(fn.id);
      const parent = model.functions.get(fn.parentId);
      if (!parent) break;
      fn = parent;
    }
    if (fn) outermost.set(id, fn);
    return fn ?? null;
  };
  const requesters = new Set<string>();
  const functionEntity = (fn: FunctionInfo): string =>
    entity({
      id: fn.id,
      class: frontendClass(fn),
      label: fn.name,
      detail: `${fn.file}:${fn.location.line}`,
      file: fn.file,
      line: fn.location.line,
      status: null,
    });
  const evidenceOf = (call: { file: string; location: { line: number }; code: string }): OntologyEvidence => ({
    file: call.file,
    line: call.location.line,
    code: call.code,
  });

  const endpointStatus = new Map<string, OntologyEntity["status"]>();
  const endpointEntity = (call: ApiCallInfo): string => {
    const key = model.apiKeyOf(call);
    const link = model.link(call.id);
    const endpoint = link?.endpointId ? model.endpoints.get(link.endpointId) : undefined;
    const status: OntologyEntity["status"] = model.hasBackend ? link?.status ?? "unresolved" : "no-backend";
    const previous = endpointStatus.get(key);
    if (previous === undefined || previous === "matched") endpointStatus.set(key, status);
    if (endpoint) return backendEndpointEntity(endpoint);
    return entity({
      id: `api:${key}`,
      class: "Endpoint",
      label: key,
      detail: null,
      file: null,
      line: null,
      status,
      attributes: { method: call.method, path: call.endpointPattern },
    });
  };

  const readsByEntity = new Map<string, { apiKey: string; endpoint: string; path: string }[]>();
  for (const call of model.apiCalls.values()) {
    const caller = ownerOf(call.callerFunctionId);
    const api = endpointEntity(call);
    const evidence = evidenceOf(call);
    let client: FunctionInfo | null = null;
    if (call.resolution === "wrapper") client = ownerOf(call.wrapperFunctionId);
    else if (call.resolution === "config") client = [...model.functions.values()].find((f) => f.name === call.calleeExpression) ?? null;

    if (client && client.id !== caller?.id) {
      requesters.add(client.id);
      triple(functionEntity(client), "requests", api);
      if (caller) triple(functionEntity(caller), "calls", client.id, evidence);
    } else if (caller) {
      requesters.add(caller.id);
      triple(functionEntity(caller), "requests", api, evidence);
    }

    for (const access of model.accessesOf(call.id)) {
      const reader = ownerOf(access.containingFunctionId);
      if (!reader) continue;
      const field = responseField(call, access.path);
      triple(functionEntity(reader), "reads", field ?? api, evidenceOf(access));
      const list = readsByEntity.get(reader.id) ?? readsByEntity.set(reader.id, []).get(reader.id)!;
      list.push({ apiKey: model.apiKeyOf(call), endpoint: api, path: formatAccessPath(access.path) });
    }
  }

  for (const fn of model.functions.values()) {
    const from = ownerOf(fn.id);
    if (!from) continue;
    if (options.includeUnrelated) functionEntity(from);
    for (const target of fn.invokes ?? []) {
      const to = ownerOf(target);
      if (to && to.id !== from.id) triple(functionEntity(from), "calls", functionEntity(to));
    }
    for (const target of fn.renders ?? []) {
      const to = ownerOf(target);
      if (to && to.id !== from.id) triple(functionEntity(from), "renders", functionEntity(to));
    }
  }

  const routes: RouteInfo[] = model.frontend.routes ?? [];
  for (const route of routes) {
    const page = entity({
      id: `page:${route.id}`,
      class: "Page",
      label: route.path ?? `${route.component} (page)`,
      detail: route.component,
      file: route.file,
      line: route.location.line,
      status: null,
      attributes: { path: route.path, source: route.source, component: route.component },
    });
    const component = ownerOf(route.componentId);
    if (component) triple(page, "showsComponent", functionEntity(component), { file: route.file, line: route.location.line, code: route.component });
    if (includeFiles) triple(page, "definedIn", fileEntity("frontend", route.file));
  }

  // ------------------------------------------------------------------ backend

  function backendEndpointEntity(endpoint: EndpointInfo): string {
    const id = `api:${endpoint.id}`;
    if (entities.has(id)) return id;
    entity({
      id,
      class: "Endpoint",
      label: endpoint.id,
      detail: endpoint.handler,
      file: endpoint.location.file,
      line: endpoint.location.line,
      status: null,
      attributes: { method: endpoint.method, path: endpoint.path, handler: endpoint.handler },
    });
    const [controllerId, method] = endpoint.handler.split("#");
    const controller = entity({
      id: `controller:${controllerId}`,
      class: "Controller",
      label: controllerId.split(".").pop()!,
      detail: controllerId,
      file: endpoint.location.file,
      line: null,
      status: null,
      attributes: { qualifiedName: controllerId },
    });
    triple(id, "handledBy", controller, { file: endpoint.location.file, line: endpoint.location.line, code: method ?? endpoint.handler });
    if (includeFiles) triple(controller, "definedIn", fileEntity("backend", endpoint.location.file));
    if (endpoint.requestBody) for (const target of typeEntities(endpoint.requestBody.type)) triple(id, "accepts", target);
    if (endpoint.response) for (const target of typeEntities(endpoint.response)) triple(id, "returns", target);
    return id;
  }

  /** Dto / Enum entities a type refers to (generic arguments, array elements and map values included). */
  function typeEntities(type: TypeRef): string[] {
    switch (type.kind) {
      case "dto": {
        const own = model.dtos.has(type.dtoId) ? [dtoEntity(type.dtoId)] : [];
        return [...own, ...type.typeArguments.flatMap(typeEntities)];
      }
      case "enum":
        return model.enums.has(type.enumId) ? [enumEntity(type.enumId)] : [];
      case "array":
        return typeEntities(type.element);
      case "map":
        return typeEntities(type.value);
      default:
        return [];
    }
  }

  function dtoEntity(dtoId: string): string {
    const id = `dto:${dtoId}`;
    if (entities.has(id)) return id;
    const dto = model.dtos.get(dtoId)!;
    entity({
      id,
      class: "Dto",
      label: dto.typeParameters.length ? `${dto.name}<${dto.typeParameters.join(", ")}>` : dto.name,
      detail: dto.id,
      file: dto.location.file,
      line: dto.location.line,
      status: null,
      attributes: { qualifiedName: dto.id, fields: dto.fields.length },
    });
    if (includeFiles) triple(id, "definedIn", fileEntity("backend", dto.location.file));
    for (const field of dto.fields) {
      const fieldId = dtoFieldEntity(dtoId, field.name);
      triple(id, "hasField", fieldId);
      for (const target of typeEntities(field.type)) triple(fieldId, "typedAs", target);
    }
    return id;
  }

  function dtoFieldEntity(dtoId: string, name: string): string {
    const dto = model.dtos.get(dtoId)!;
    const field = dto.fields.find((f) => f.name === name)!;
    return entity({
      id: `field:${dtoId}.${name}`,
      class: "DtoField",
      label: `${dto.name}.${name}`,
      detail: describeType(field.type, lookup),
      file: dto.location.file,
      line: dto.location.line,
      status: null,
      attributes: { type: describeType(field.type, lookup), nullable: field.nullable },
    });
  }

  function enumEntity(enumId: string): string {
    const id = `enum:${enumId}`;
    if (entities.has(id)) return id;
    const e = model.enums.get(enumId)!;
    entity({
      id,
      class: "Enum",
      label: e.name,
      detail: e.values.join(" | "),
      file: e.location.file,
      line: e.location.line,
      status: null,
      attributes: { qualifiedName: e.id, values: e.values.join(",") },
    });
    if (includeFiles) triple(id, "definedIn", fileEntity("backend", e.location.file));
    return id;
  }

  /** The DTO field an access path ends in, e.g. ["profile", "email"] → field:...Profile.email. */
  function responseField(call: ApiCallInfo, path: string[]): string | null {
    const endpointId = model.link(call.id)?.endpointId;
    const response = endpointId ? model.endpoints.get(endpointId)?.response : null;
    if (!response) return null;
    const segments = [...path];
    while (segments.length && (segments.at(-1) === "[]" || segments.at(-1) === "length")) segments.pop();
    if (!segments.length) return null;
    const parent = checkPath(response, segments.slice(0, -1), lookup);
    if (parent.status !== "ok" || parent.type.kind !== "dto") return null;
    const dto = model.dtos.get(parent.type.dtoId);
    if (!dto?.fields.some((f) => f.name === segments.at(-1))) return null;
    dtoEntity(dto.id);
    return dtoFieldEntity(dto.id, segments.at(-1)!);
  }

  for (const endpoint of model.endpoints.values()) backendEndpointEntity(endpoint);
  for (const [key, status] of endpointStatus) {
    const e = entities.get(`api:${key}`);
    if (e) e.status = status;
  }
  for (const e of entities.values()) {
    if (e.class === "Endpoint" && e.status === null) e.status = "unused";
  }

  // ------------------------------------------------------------------ classes, pruning, inference

  for (const id of requesters) {
    const e = entities.get(id);
    if (e?.class === "Function") e.class = "ApiClient";
  }

  const all = [...triples.values()];
  if (!options.includeUnrelated) prune(entities, all);
  const kept = all.filter((t) => entities.has(t.subject) && entities.has(t.object));

  const frontendIds = new Set([...entities.values()].filter((e) => FRONTEND_CLASSES.has(e.class)).map((e) => e.id));
  if (includeFiles) {
    for (const id of frontendIds) {
      const fn = model.functions.get(id);
      if (fn) kept.push({ subject: id, predicate: "definedIn", object: fileEntity("frontend", fn.file), inferred: false, evidence: [] });
    }
  }

  const { pages, uses } = inferPageApis(entities, kept, readsByEntity);
  kept.push(...uses);
  const commonApis = markCommonApis(entities, pages, model.config.commonApis);
  relatePages(pages);

  const sorted = [...entities.values()].sort(
    (a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
  const stats: Ontology["stats"] = { entities: {}, triples: kept.length, inferred: kept.filter((t) => t.inferred).length };
  for (const e of sorted) stats.entities[e.class] = (stats.entities[e.class] ?? 0) + 1;
  return { schema: ONTOLOGY_SCHEMA, entities: sorted, triples: kept, pages, stats, commonApis, rootDir: model.frontend.rootDir };
}

const CLASS_ORDER: OntologyClass[] = [
  "Page", "Component", "Hook", "Function", "ApiClient", "Endpoint", "Controller", "Dto", "DtoField", "Enum", "File",
];
const FRONTEND_CLASSES = new Set<OntologyClass>(["Component", "Hook", "ApiClient", "Function"]);
const PAGE_EDGES = new Set<OntologyPredicate>(["showsComponent", "renders", "calls", "requests"]);

function frontendClass(fn: FunctionInfo): OntologyClass {
  if (fn.containingComponent === fn.name) return "Component";
  if (/^use[A-Z0-9]/.test(fn.name.split(".").pop()!)) return "Hook";
  return "Function";
}

/** Drops frontend functions that neither lead to an API nor belong to a page. */
function prune(entities: Map<string, OntologyEntity>, triples: OntologyTriple[]): void {
  const into = new Map<string, string[]>();
  for (const t of triples) {
    if (t.predicate === "calls" || t.predicate === "renders" || t.predicate === "requests" || t.predicate === "reads") {
      (into.get(t.object) ?? into.set(t.object, []).get(t.object)!).push(t.subject);
    }
  }
  const keep = new Set<string>();
  const queue = [...entities.values()].filter((e) => e.class === "Endpoint" || e.class === "DtoField").map((e) => e.id);
  for (const id of queue) keep.add(id);
  while (queue.length) {
    for (const prev of into.get(queue.shift()!) ?? []) {
      if (!keep.has(prev)) {
        keep.add(prev);
        queue.push(prev);
      }
    }
  }
  const pageComponents = new Set(
    triples.filter((t) => t.predicate === "showsComponent").map((t) => t.object),
  );
  for (const [id, e] of entities) {
    if (FRONTEND_CLASSES.has(e.class) && !keep.has(id) && !pageComponents.has(id)) entities.delete(id);
  }
}

/** Page → API rows (labels in `via`) and the matching usesApi triples (ids in `via`). */
function inferPageApis(
  entities: Map<string, OntologyEntity>,
  triples: OntologyTriple[],
  readsByEntity: Map<string, { apiKey: string; endpoint: string; path: string }[]>,
): { pages: PageApis[]; uses: OntologyTriple[] } {
  const uses: OntologyTriple[] = [];
  const out = new Map<string, string[]>();
  for (const t of triples) {
    if (PAGE_EDGES.has(t.predicate)) (out.get(t.subject) ?? out.set(t.subject, []).get(t.subject)!).push(t.object);
  }
  const label = (id: string) => entities.get(id)?.label ?? id;
  const pages: PageApis[] = [];
  for (const page of entities.values()) {
    if (page.class !== "Page") continue;
    const parent = new Map<string, string | null>([[page.id, null]]);
    const order: string[] = [page.id];
    for (let i = 0; i < order.length; i++) {
      const current = order[i];
      if (entities.get(current)?.class === "Endpoint") continue;
      for (const next of out.get(current) ?? []) {
        if (!parent.has(next)) {
          parent.set(next, current);
          order.push(next);
        }
      }
    }
    const pathTo = (id: string): string[] => {
      const path: string[] = [];
      for (let at: string | null = id; at !== null; at = parent.get(at) ?? null) path.unshift(at);
      return path;
    };

    const apis = new Map<string, PageApiUse & { viaIds: string[] }>();
    const use = (endpoint: string, viaIds: string[]): PageApiUse & { viaIds: string[] } => {
      const existing = apis.get(endpoint);
      if (existing) return existing;
      const e = entities.get(endpoint)!;
      const created = { endpoint, apiKey: e.label, status: e.status, via: viaIds.map(label), viaIds, fields: [] as string[] };
      apis.set(endpoint, created);
      return created;
    };
    for (const id of order) {
      if (entities.get(id)?.class === "Endpoint") use(id, pathTo(id));
    }
    // Reads only add fields to APIs the page requests: a shared helper (`formatDate(row.createdAt)`) reads
    // whatever API data it was last given, which says nothing about this page.
    for (const id of order) {
      for (const read of readsByEntity.get(id) ?? []) {
        const api = apis.get(read.endpoint);
        if (api && !api.fields.includes(read.path)) api.fields.push(read.path);
      }
    }
    const list = [...apis.values()].sort((a, b) => a.apiKey.localeCompare(b.apiKey));
    for (const api of list) {
      api.fields.sort();
      uses.push({ subject: page.id, predicate: "usesApi", object: api.endpoint, inferred: true, evidence: [], via: api.viaIds });
    }
    pages.push({
      page: page.id,
      route: (page.attributes.path as string | null) ?? null,
      component: String(page.attributes.component ?? page.label),
      file: page.file ?? "",
      apis: list.map(({ viaIds: _ids, ...rest }) => rest),
    });
  }
  pages.sort((a, b) => (a.route ?? "\uffff").localeCompare(b.route ?? "\uffff") || a.component.localeCompare(b.component));
  return { pages, uses };
}

/** Defaults: an API used by at least this share of all pages (and by at least COMMON_API_MIN_PAGES) is common. */
export const COMMON_API_SHARE = 0.25;
export const COMMON_API_MIN_PAGES = 8;

/** The effective rule for a project: tacet.config.json `commonApis` over the defaults. */
export function commonApiRule(config: CommonApisConfig = {}, pageCount: number): CommonApiRule {
  const share = config.share ?? COMMON_API_SHARE;
  const minPages = config.minPages ?? COMMON_API_MIN_PAGES;
  if (!(share > 0 && share <= 1)) throw new Error(`commonApis.share must be in (0, 1], got ${share}`);
  if (!(Number.isInteger(minPages) && minPages >= 1)) throw new Error(`commonApis.minPages must be a positive integer, got ${minPages}`);
  return {
    share,
    minPages,
    include: config.include ?? [],
    exclude: config.exclude ?? [],
    threshold: Math.max(minPages, Math.ceil(pageCount * share)),
  };
}

/**
 * Marks APIs nearly every page uses (a permission check in the layout, an icon fetch). They connect every page to
 * every other, so views leave them out by default. Endpoint entities get `pages` (how many pages use them) and `common`.
 */
function markCommonApis(entities: Map<string, OntologyEntity>, pages: PageApis[], config?: CommonApisConfig): CommonApiRule {
  const rule = commonApiRule(config, pages.length);
  const counts = new Map<string, number>();
  for (const page of pages) for (const api of page.apis) counts.set(api.endpoint, (counts.get(api.endpoint) ?? 0) + 1);
  const include = new Set(rule.include), exclude = new Set(rule.exclude);
  const common = new Set(
    [...entities.values()]
      .filter((e) => e.class === "Endpoint")
      .filter((e) => !exclude.has(e.label) && (include.has(e.label) || (counts.get(e.id) ?? 0) >= rule.threshold))
      .map((e) => e.id),
  );
  for (const e of entities.values()) {
    if (e.class !== "Endpoint") continue;
    e.attributes.pages = counts.get(e.id) ?? 0;
    e.attributes.common = common.has(e.id);
  }
  for (const page of pages) for (const api of page.apis) if (common.has(api.endpoint)) api.common = true;
  return rule;
}

/** For each page, the pages sharing the most non-common APIs with it. */
function relatePages(pages: PageApis[]): void {
  const pagesByApi = new Map<string, PageApis[]>();
  for (const page of pages) {
    for (const api of page.apis) if (!api.common) (pagesByApi.get(api.endpoint) ?? pagesByApi.set(api.endpoint, []).get(api.endpoint)!).push(page);
  }
  for (const page of pages) {
    const shared = new Map<PageApis, string[]>();
    for (const api of page.apis) {
      if (api.common) continue;
      for (const other of pagesByApi.get(api.endpoint) ?? []) {
        if (other !== page) (shared.get(other) ?? shared.set(other, []).get(other)!).push(api.apiKey);
      }
    }
    page.related = [...shared]
      .sort(([a, x], [b, y]) => y.length - x.length || (a.route ?? "").localeCompare(b.route ?? "") || a.page.localeCompare(b.page))
      .slice(0, 8)
      .map(([other, apis]) => ({
        page: other.page,
        route: other.route,
        component: other.component,
        shared: apis.length,
        apis: apis.slice(0, 10),
      }));
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Entities whose id or label matches the query: exact matches first, otherwise case-insensitive substrings. */
export function findEntities(ontology: Ontology, query: string): OntologyEntity[] {
  const exact = ontology.entities.filter((e) => e.id === query || e.label === query);
  if (exact.length) return exact;
  const q = query.toLowerCase();
  return ontology.entities.filter((e) => e.class !== "File" && (e.label.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)));
}

/**
 * The part of the ontology around the entities matching `query`: everything within `depth` triples
 * (in either direction), plus the page rows involving any of those entities.
 */
export function focusOntology(ontology: Ontology, query: string, depth = 2): Ontology {
  const seeds = findEntities(ontology, query);
  const keep = new Set(seeds.map((e) => e.id));
  const neighbors = new Map<string, string[]>();
  const link = (a: string, b: string) => (neighbors.get(a) ?? neighbors.set(a, []).get(a)!).push(b);
  const byId = new Map(ontology.entities.map((e) => [e.id, e]));
  for (const t of ontology.triples) {
    if (t.predicate === "definedIn" && !keep.has(t.object)) continue;
    link(t.subject, t.object);
    link(t.object, t.subject);
  }
  let frontier = [...keep];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      // Do not expand through hubs that connect everything (files, generic envelopes).
      if (d > 0 && byId.get(id)?.class === "File") continue;
      for (const n of neighbors.get(id) ?? []) {
        if (!keep.has(n)) {
          keep.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  const entities = ontology.entities.filter((e) => keep.has(e.id));
  const triples = ontology.triples.filter((t) => keep.has(t.subject) && keep.has(t.object));
  const pages = ontology.pages
    .filter((p) => keep.has(p.page) || p.apis.some((a) => keep.has(a.endpoint)))
    .map((p) => (keep.has(p.page) ? p : { ...p, apis: p.apis.filter((a) => keep.has(a.endpoint)) }));
  const stats: Ontology["stats"] = { entities: {}, triples: triples.length, inferred: triples.filter((t) => t.inferred).length };
  for (const e of entities) stats.entities[e.class] = (stats.entities[e.class] ?? 0) + 1;
  return { schema: ontology.schema, entities, triples, pages, stats, commonApis: ontology.commonApis, rootDir: ontology.rootDir };
}

export interface ApiPages {
  endpoint: string;
  apiKey: string;
  status: OntologyEntity["status"];
  pages: { page: string; route: string | null; component: string; via: string[]; fields: string[] }[];
}

/** The reverse of `ontology.pages`: for every endpoint, the pages using it. */
export function pagesByApi(ontology: Ontology): ApiPages[] {
  const rows = new Map<string, ApiPages>();
  for (const e of ontology.entities) {
    if (e.class === "Endpoint") rows.set(e.id, { endpoint: e.id, apiKey: e.label, status: e.status, pages: [] });
  }
  for (const page of ontology.pages) {
    for (const api of page.apis) {
      rows.get(api.endpoint)?.pages.push({ page: page.page, route: page.route, component: page.component, via: api.via, fields: api.fields });
    }
  }
  return [...rows.values()].sort((a, b) => a.apiKey.localeCompare(b.apiKey));
}
