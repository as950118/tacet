import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve, sep } from "node:path";
import {
  attachGraph,
  findEntities,
  mergeGraphs,
  openIndexDatabase,
  renderHtml,
  renderMermaid,
  renderOntologyHtml,
  renderOntologyMermaid,
  renderOntologyTurtle,
  type GraphAttachment,
  type ImpactGraph,
  type IndexDatabase,
} from "@tacet-api/core";
import { DEFAULT_INDEX_PATH, TacetWorkspace } from "./workspace.js";

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export interface TacetApiServerOptions {
  /** Index database: a SQLite file or a postgres:// URL (default .tacet/index.db). */
  index?: string;
  /** tacet.config.json applied to every project (otherwise each project's own, stored at index time). */
  configPath?: string;
  /** Bearer token every request except /health and /openapi.json must carry. */
  token?: string;
  /** Directories the indexing endpoints may read (default: the current directory). */
  allowDirs?: string[];
  /** Value for Access-Control-Allow-Origin, for dashboards in a browser. */
  cors?: string;
}

export interface TacetApiServer {
  server: Server;
  database: IndexDatabase;
  /** Handles one request; usable without listening, e.g. inside another HTTP framework. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

type ParamType = "string" | "integer" | "boolean" | "string[]";

interface Param {
  type: ParamType;
  description: string;
  required?: boolean;
  enum?: string[];
}

interface Context {
  ws: TacetWorkspace;
  query: Query;
  body: Record<string, unknown>;
}

/** A response other than JSON. */
interface Raw {
  raw: string;
  contentType: string;
}

interface Route {
  method: "GET" | "POST" | "DELETE";
  /** Under /projects/{project} unless `global`. */
  path: string;
  global?: boolean;
  summary: string;
  tag: string;
  query?: Record<string, Param>;
  body?: Record<string, Param>;
  /** Writes the index: serialized per project. */
  write?: boolean;
  handle(ctx: Context): Promise<unknown>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_BODY = 1024 * 1024;

const graphParam: Param = { type: "string", enum: ["none", "mermaid", "json"], description: "Attach the impact graph (default none)" };

/**
 * A REST API over the index: read the page ↔ API map, relations, ontology, impact and contract checks of any project
 * in the database, and trigger indexing. Every route is also described at GET /openapi.json.
 */
export async function createTacetApiServer(options: TacetApiServerOptions = {}): Promise<TacetApiServer> {
  const location = options.index ?? DEFAULT_INDEX_PATH;
  const database = await openIndexDatabase(location);
  const allowDirs = (options.allowDirs?.length ? options.allowDirs : [process.cwd()]).map((d) => canonical(resolve(d)));
  const workspaces = new Map<string, TacetWorkspace>();
  const writeLocks = new Map<string, Promise<unknown>>();

  const workspace = (project: string) => {
    let ws = workspaces.get(project);
    if (!ws) {
      ws = new TacetWorkspace(location, options.configPath, { project, database });
      workspaces.set(project, ws);
    }
    return ws;
  };

  /** One write at a time per project: indexing keeps the parsed frontend in memory between calls. */
  const serialized = <T>(project: string, work: () => Promise<T>): Promise<T> => {
    const run = (writeLocks.get(project) ?? Promise.resolve()).catch(() => undefined).then(work);
    writeLocks.set(project, run);
    void run.finally(() => {
      if (writeLocks.get(project) === run) writeLocks.delete(project);
    }).catch(() => undefined);
    return run;
  };

  /** A path inside the allowed directories (symlinks resolved), or a 400 / 403. */
  const allowedDir = (value: unknown, name: string): string => {
    if (typeof value !== "string" || !value) throw new HttpError(400, `\`${name}\` is required`);
    const dir = canonical(resolve(value));
    if (!allowDirs.some((root) => dir === root || dir.startsWith(root + sep))) {
      throw new HttpError(403, `\`${name}\` must be inside an allowed directory (${allowDirs.join(", ")}); see --allow-dir`);
    }
    return dir;
  };

  const routes: Route[] = [
    {
      method: "GET",
      path: "/health",
      global: true,
      tag: "server",
      summary: "Liveness, version and index database",
      handle: async () => ({ status: "ok", version: VERSION, index: { dialect: database.dialect, location: database.location } }),
    },
    {
      method: "GET",
      path: "/projects",
      global: true,
      tag: "projects",
      summary: "Projects in the index database, with when their frontend and backend were last indexed",
      handle: async () => database.listProjects(),
    },
    {
      method: "GET",
      path: "",
      tag: "projects",
      summary: "What the index holds for a project",
      handle: async ({ ws }) => ws.status(),
    },
    {
      method: "DELETE",
      path: "",
      tag: "projects",
      summary: "Remove everything indexed for a project",
      write: true,
      handle: async ({ ws }) => {
        await ws.clear();
        return { deleted: ws.project };
      },
    },
    {
      method: "POST",
      path: "/frontend",
      tag: "indexing",
      summary: "Index a TypeScript frontend (only changed records are rewritten)",
      body: {
        dir: { type: "string", required: true, description: "Frontend root on the server, inside an allowed directory" },
        files: { type: "string[]", description: "Changed files: the result lists the APIs they use" },
        changedSince: { type: "string", description: "Git ref: use the TS files changed since it as `files`" },
        check: { type: "boolean", description: "Also check the scope against the backend contract" },
        config: { type: "string", description: "tacet.config.json on the server (default <dir>/tacet.config.json)" },
      },
      write: true,
      handle: async ({ ws, body }) => {
        const result = await ws.indexFrontend(allowedDir(body.dir, "dir"), {
          configPath: body.config === undefined ? undefined : allowedDir(body.config, "config"),
          files: body.files as string[] | undefined,
          changedSince: body.changedSince as string | undefined,
        });
        return body.check ? { ...result, check: await ws.check({ files: result.scope ?? undefined }) } : result;
      },
    },
    {
      method: "POST",
      path: "/backend",
      tag: "indexing",
      summary: "Extract the Spring Boot API contract (endpoints, DTOs) into the index (needs Java 17+)",
      body: { dir: { type: "string", required: true, description: "Backend root on the server, inside an allowed directory" } },
      write: true,
      handle: async ({ ws, body }) => ws.extractBackend(allowedDir(body.dir, "dir")),
    },
    {
      method: "POST",
      path: "/analyze",
      tag: "indexing",
      summary: "Diff the stored backend contract against a backend directory and list the affected frontend code",
      body: {
        dir: { type: "string", required: true, description: "Backend root with the change, inside an allowed directory" },
        save: { type: "boolean", description: "Store the analyzed backend as the new baseline" },
      },
      write: true,
      handle: async ({ ws, body }) => ws.analyzeBackend(allowedDir(body.dir, "dir"), { save: body.save === true }),
    },
    {
      method: "GET",
      path: "/pages",
      tag: "relations",
      summary: "Which page uses which API: call chain and response fields read per page, or the pages of each API",
      query: {
        page: { type: "string", description: 'Route or component substring, e.g. "/users" or "UserPage"' },
        api: { type: "string", description: 'API substring, e.g. "GET /users/{id}"; groups the result by API' },
      },
      handle: async ({ ws, query }) => ws.pageApis({ page: query.string("page"), api: query.string("api") }),
    },
    {
      method: "GET",
      path: "/relations",
      tag: "relations",
      summary: "Stored relations: a page's APIs, an API's pages, or triples by subject / predicate / object",
      query: {
        page: { type: "string", description: 'Page route or entity id, e.g. "/users/:id"' },
        api: { type: "string", description: 'API, e.g. "GET /users/{id}"' },
        subject: { type: "string", description: "Entity id or exact label" },
        predicate: { type: "string", description: "showsComponent, renders, calls, requests, reads, usesApi, handledBy, …" },
        object: { type: "string", description: "Entity id or exact label" },
        limit: { type: "integer", description: "At most this many relations" },
      },
      handle: async ({ ws, query }) => {
        const q = {
          page: query.string("page"),
          api: query.string("api"),
          subject: query.string("subject"),
          predicate: query.string("predicate"),
          object: query.string("object"),
          limit: query.integer("limit"),
        };
        if (Object.values(q).every((v) => v === undefined)) {
          throw new HttpError(400, "Pass page, api, or subject / predicate / object");
        }
        return ws.relations(q);
      },
    },
    {
      method: "GET",
      path: "/ontology",
      tag: "relations",
      summary: "Typed entities and subject–predicate–object triples, as JSON, Mermaid, RDF Turtle or an HTML explorer",
      query: {
        focus: { type: "string", description: "Only the neighborhood of this entity (route, component, API, DTO, …)" },
        depth: { type: "integer", description: "With focus: relations to follow (default 2)" },
        files: { type: "boolean", description: "Include File entities and definedIn triples (default false)" },
        all: { type: "boolean", description: "Keep frontend functions that lead to no API" },
        format: { type: "string", enum: ["json", "mermaid", "turtle", "html"], description: "Default json" },
      },
      handle: async ({ ws, query }) => {
        const format = query.string("format") ?? "json";
        const focus = query.string("focus");
        const ontology = await ws.ontology({
          focus,
          depth: query.integer("depth"),
          includeFiles: query.boolean("files") ?? format === "html",
          includeUnrelated: query.boolean("all"),
        });
        if (focus && !findEntities(ontology, focus).length) throw new HttpError(404, `No entity matches "${focus}"`);
        if (format === "mermaid") return text(renderOntologyMermaid(ontology));
        if (format === "turtle") return { raw: renderOntologyTurtle(ontology), contentType: "text/turtle; charset=utf-8" };
        if (format === "html") {
          const usage = (await ws.hasBackendBaseline()) ? await ws.usage() : undefined;
          return html(renderOntologyHtml(ontology, { title: `Tacet ontology: ${ws.project}${focus ? ` / ${focus}` : ""}`, usage }));
        }
        return ontology;
      },
    },
    {
      method: "GET",
      path: "/check",
      tag: "analysis",
      summary: "Check frontend API usage against the backend contract (endpoints, methods, fields, params)",
      query: {
        files: { type: "string[]", description: "Only APIs used by these frontend files (repeat or comma-separate)" },
        changedSince: { type: "string", description: "Only APIs used by TS files changed since this git ref" },
      },
      handle: async ({ ws, query }) => ws.check({ files: query.list("files"), changedSince: query.string("changedSince") }),
    },
    {
      method: "GET",
      path: "/impact",
      tag: "analysis",
      summary: "What a change would affect: an API, a frontend file or a response field; without one, a ranking of all",
      query: {
        api: { type: "string", description: 'e.g. "GET /users/{id}" or "/users/{id}"' },
        file: { type: "string", description: "Frontend file, relative to the frontend root" },
        field: { type: "string", description: 'e.g. "UserResponse.name"' },
        graph: graphParam,
      },
      handle: async ({ ws, query }) => {
        const analyzer = await ws.impact();
        const graph = (query.string("graph") ?? "none") as GraphAttachment;
        const api = query.string("api");
        const file = query.string("file");
        const field = query.string("field");
        if (api) return analyzer.impactOfApi(api).map((i) => attachGraph(i, graph));
        if (file) return attachGraph(analyzer.impactOfFile(await ws.toIndexPath(file)), graph);
        if (field) return analyzer.impactOfField(field).map((i) => attachGraph(i, graph));
        return analyzer.summary();
      },
    },
    {
      method: "GET",
      path: "/search",
      tag: "analysis",
      summary: "Search APIs, files, functions, components, DTOs and fields",
      query: { q: { type: "string", required: true, description: "Case-insensitive substring" } },
      handle: async ({ ws, query }) => (await ws.impact()).search(query.string("q")!),
    },
    {
      method: "GET",
      path: "/graph",
      tag: "analysis",
      summary: "The API → field → function → component → file graph, whole or for one api / file / field",
      query: {
        api: { type: "string", description: "Only the graph of this API" },
        file: { type: "string", description: "Only the graph of this frontend file" },
        field: { type: "string", description: "Only the graph of this response field" },
        format: { type: "string", enum: ["json", "mermaid", "html"], description: "Default json" },
      },
      handle: async ({ ws, query }) => {
        const analyzer = await ws.impact();
        const api = query.string("api");
        const file = query.string("file");
        const field = query.string("field");
        const graph: ImpactGraph = api
          ? mergeGraphs(analyzer.impactOfApi(api).map((i) => i.graph))
          : file
            ? analyzer.impactOfFile(await ws.toIndexPath(file)).graph
            : field
              ? mergeGraphs(analyzer.impactOfField(field).map((i) => i.graph))
              : analyzer.fullGraph();
        const format = query.string("format") ?? "json";
        if (format === "mermaid") return text(renderMermaid(graph));
        if (format === "html") return html(renderHtml(graph, { title: `Tacet: ${api ?? file ?? field ?? ws.project}` }));
        return graph;
      },
    },
    {
      method: "GET",
      path: "/unused",
      tag: "analysis",
      summary: "Backend endpoints nothing calls (this frontend, the `also` projects, or a backend service client)",
      query: {
        also: { type: "string[]", description: "Other projects in this database using the same backend" },
        all: { type: "boolean", description: "Every endpoint with its usage, not only the unused ones" },
      },
      handle: async ({ ws, query }) => {
        const report = await ws.usage([], query.list("also"));
        return query.boolean("all")
          ? report
          : { ...report, endpoints: report.endpoints.filter((e) => e.usage === "unused" || e.usage === "client-declared") };
      },
    },
  ];

  const openapi = openApiDocument(routes, Boolean(options.token));

  const authorized = (req: IncomingMessage): boolean => {
    if (!options.token) return true;
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    const expected = Buffer.from(options.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (options.cors) {
      res.setHeader("Access-Control-Allow-Origin", options.cors);
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (req.method === "OPTIONS") return send(res, 204, null);
      if (req.method === "GET" && path === "/openapi.json") return send(res, 200, openapi);
      const match = matchRoute(routes, req.method ?? "GET", path);
      if (!match) throw new HttpError(404, `No route ${req.method} ${path}; see GET /openapi.json`);
      if (match.route.path !== "/health" && !authorized(req)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        throw new HttpError(401, "Missing or wrong bearer token");
      }
      const body = req.method === "POST" ? await readJson(req) : {};
      const query = new Query(url.searchParams);
      validate(match.route, query, body);
      const ws = match.project === null ? (undefined as unknown as TacetWorkspace) : workspace(match.project);
      const run = () => match.route.handle({ ws, query, body });
      const result = match.route.write && match.project !== null ? await serialized(match.project, run) : await run();
      return send(res, 200, result);
    } catch (err) {
      const status = statusOf(err);
      if (status >= 500) console.error(err);
      return send(res, status, { error: (err as Error).message });
    }
  };

  const server = createServer((req, res) => void handle(req, res));
  return {
    server,
    database,
    handle,
    listen: (port = 4318, host = "127.0.0.1") =>
      new Promise((resolveUrl, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address() as AddressInfo;
          const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
          resolveUrl(`http://${shown}:${address.port}`);
        });
      }),
    close: async () => {
      await new Promise<void>((done) => (server.listening ? server.close(() => done()) : done()));
      server.closeAllConnections?.();
      await database.close();
    },
  };
}

/** Whether a host name only accepts connections from this machine. */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

class Query {
  constructor(private readonly params: URLSearchParams) {}

  string(name: string): string | undefined {
    const value = this.params.get(name);
    return value === null || value === "" ? undefined : value;
  }

  /** Repeated (`?f=a&f=b`) and/or comma-separated (`?f=a,b`) values. */
  list(name: string): string[] | undefined {
    const values = this.params.getAll(name).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
    return values.length ? values : undefined;
  }

  integer(name: string): number | undefined {
    const value = this.string(name);
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new HttpError(400, `\`${name}\` must be a non-negative integer`);
    return Number.parseInt(value, 10);
  }

  boolean(name: string): boolean | undefined {
    const value = this.string(name);
    if (value === undefined) return this.params.has(name) ? true : undefined;
    if (["true", "1", "yes"].includes(value)) return true;
    if (["false", "0", "no"].includes(value)) return false;
    throw new HttpError(400, `\`${name}\` must be true or false`);
  }
}

function matchRoute(routes: Route[], method: string, path: string): { route: Route; project: string | null } | null {
  for (const route of routes.filter((r) => r.global)) {
    if (route.path === path && route.method === method) return { route, project: null };
  }
  const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return null;
  const project = decodeURIComponent(m[1]);
  if (!PROJECT_NAME.test(project)) throw new HttpError(400, `Invalid project name "${project}" (letters, digits, . _ -)`);
  const rest = m[2] ?? "";
  const route = routes.find((r) => !r.global && r.path === rest && r.method === method);
  if (!route) {
    if (routes.some((r) => !r.global && r.path === rest)) throw new HttpError(405, `${method} is not supported on ${path}`);
    return null;
  }
  return { route, project };
}

function validate(route: Route, query: Query, body: Record<string, unknown>): void {
  for (const [name, param] of Object.entries(route.query ?? {})) {
    if (param.type === "integer") query.integer(name);
    if (param.type === "boolean") query.boolean(name);
    const value = query.string(name);
    if (param.required && value === undefined) throw new HttpError(400, `Query parameter \`${name}\` is required`);
    if (param.enum && value !== undefined && !param.enum.includes(value)) {
      throw new HttpError(400, `\`${name}\` must be one of ${param.enum.join(", ")}`);
    }
  }
  for (const [name, param] of Object.entries(route.body ?? {})) {
    const value = body[name];
    if (value === undefined || value === null) {
      if (param.required) throw new HttpError(400, `Body field \`${name}\` is required`);
      continue;
    }
    const ok =
      param.type === "string[]"
        ? Array.isArray(value) && value.every((v) => typeof v === "string")
        : param.type === "integer"
          ? Number.isInteger(value)
          : typeof value === param.type;
    if (!ok) throw new HttpError(400, `Body field \`${name}\` must be ${param.type}`);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "Request body must be a JSON object");
  return value as Record<string, unknown>;
}

function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (!(err instanceof Error) || err.constructor !== Error) return 500;
  // The workspace reports missing things as "No frontend index …", "No Page "/x" in the index", …
  if (/^No /.test(err.message) || /not found/i.test(err.message)) return 404;
  return 400;
}

function text(value: string): Raw {
  return { raw: value, contentType: "text/plain; charset=utf-8" };
}

function html(value: string): Raw {
  return { raw: value, contentType: "text/html; charset=utf-8" };
}

function send(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  if (value === null) {
    res.writeHead(status).end();
    return;
  }
  const raw = value as Partial<Raw>;
  if (typeof raw.raw === "string" && typeof raw.contentType === "string") {
    res.writeHead(status, { "Content-Type": raw.contentType }).end(raw.raw);
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
}

function canonical(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function schemaOf(param: Param): Record<string, unknown> {
  const base =
    param.type === "string[]" ? { type: "array", items: { type: "string" } } : { type: param.type === "integer" ? "integer" : param.type };
  return { ...base, ...(param.enum ? { enum: param.enum } : {}), description: param.description };
}

/** OpenAPI 3.1 description of the routes. */
function openApiDocument(routes: Route[], secured: boolean): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const path = route.global ? route.path : `/projects/{project}${route.path}`;
    const parameters = [
      ...(route.global ? [] : [{ name: "project", in: "path", required: true, schema: { type: "string", pattern: PROJECT_NAME.source } }]),
      ...Object.entries(route.query ?? {}).map(([name, p]) => ({
        name,
        in: "query",
        required: p.required ?? false,
        ...(p.type === "string[]" ? { style: "form", explode: true } : {}),
        schema: schemaOf(p),
      })),
    ];
    const body = route.body
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: Object.entries(route.body).filter(([, p]) => p.required).map(([n]) => n),
                  properties: Object.fromEntries(Object.entries(route.body).map(([n, p]) => [n, schemaOf(p)])),
                },
              },
            },
          },
        }
      : {};
    paths[path] = {
      ...paths[path],
      [route.method.toLowerCase()]: {
        summary: route.summary,
        tags: [route.tag],
        parameters,
        ...body,
        ...(route.path === "/health" || !secured ? { security: [] } : {}),
        responses: {
          "200": { description: "OK" },
          "400": { description: "Bad request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Tacet API",
      version: VERSION,
      description: "Which frontend page uses which backend API, and what a change would affect. Data comes from the Tacet index database.",
    },
    paths,
    components: {
      schemas: { Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] } },
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
    security: secured ? [{ bearer: [] }] : [],
  };
}
