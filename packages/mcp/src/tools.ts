import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  attachGraph,
  findEntities,
  mergeGraphs,
  pagesByApi,
  renderChangeReportMarkdown,
  renderHtml,
  renderMermaid,
  renderOntologyHtml,
  renderOntologyMermaid,
  renderOntologyTurtle,
  type ChangeReport,
  type VerifiedChangeReport,
} from "@tacet-api/core";
import { TacetWorkspace, createAiProvider } from "@tacet-api/cli";
import type { AiProvider } from "@tacet-api/core";

export interface TacetToolOptions {
  /** Index database. Defaults to .tacet/index.db (relative to the server's cwd). */
  indexPath?: string;
  configPath?: string;
  /** Default frontend root, so clients can call index_frontend without knowing paths. */
  frontendDir?: string;
  /** Default backend root for extract_backend. */
  backendDir?: string;
  /** Share a workspace with the host (it keeps the parsed frontend in memory between calls). */
  workspace?: TacetWorkspace;
  /** AI provider for verify_api_changes; defaults to $TACET_AI_PROVIDER or "anthropic". */
  aiProvider?: AiProvider;
}

export interface TacetTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  parameters: z.ZodObject<Shape>;
  readOnly: boolean;
  /** Returns a JSON-serializable result. */
  run(args: z.infer<z.ZodObject<Shape>>): Promise<unknown>;
}

const reportFormat = z
  .enum(["json", "markdown"])
  .default("json")
  .describe('"markdown" returns a PR-comment-ready report instead of the structured result');

const graphOption = z
  .enum(["none", "mermaid", "json"])
  .default("none")
  .describe('Attach the impact graph: "mermaid" (compact text), "json" (nodes/edges), or "none"');

/** Framework-neutral Tacet tool definitions (zod schemas + JSON-returning handlers). */
export function createTacetTools(options: TacetToolOptions = {}): TacetTool[] {
  const ws = options.workspace ?? new TacetWorkspace(options.indexPath, options.configPath);
  const frontendDir = (dir?: string) => required(dir ?? options.frontendDir, "frontendDir");
  const backendDir = (dir?: string) => required(dir ?? options.backendDir, "backendDir");

  return [
    tool({
      name: "index_frontend",
      title: "Index the frontend",
      description:
        "Analyze the TypeScript frontend and update the Tacet index. Pass `files` (or `changedSince`, a git ref) " +
        "after editing code to get the APIs those files use; only changed index records are rewritten.",
      parameters: {
        frontendDir: z.string().optional().describe("Frontend root (defaults to the server's configured frontend)"),
        files: z.array(z.string()).optional().describe("Changed files, relative to the frontend root or absolute"),
        changedSince: z.string().optional().describe("Git ref; use the TS files changed since it"),
      },
      readOnly: false,
      run: (a) => ws.indexFrontend(frontendDir(a.frontendDir), { files: a.files, changedSince: a.changedSince }),
    }),
    tool({
      name: "extract_backend",
      title: "Extract the backend API contract",
      description: "Extract endpoints and DTOs from the Spring Boot backend sources into the index (requires Java 17+).",
      parameters: {
        backendDir: z.string().optional().describe("Backend root (defaults to the server's configured backend)"),
      },
      readOnly: false,
      run: (a) => ws.extractBackend(backendDir(a.backendDir)),
    }),
    tool({
      name: "check_contract",
      title: "Check frontend against the API contract",
      description:
        "Verify frontend API usage against the real backend contract: endpoint exists for the method, response fields " +
        "read by the frontend exist (with typo suggestions), array/object shape, request body and query keys. " +
        "Limit to changed code with `files` or `changedSince`. Returns PASS/WARNING/FAIL with file:line evidence.",
      parameters: {
        files: z.array(z.string()).optional().describe("Only APIs used by these frontend files"),
        changedSince: z.string().optional().describe("Only APIs used by TS files changed since this git ref"),
      },
      readOnly: true,
      run: async (a) => ws.check({ files: a.files, changedSince: a.changedSince }),
    }),
    tool({
      name: "analyze_api_changes",
      title: "Analyze backend API changes",
      description:
        "Diff the backend contract stored in the index (what the frontend was built against) with the backend sources " +
        "now, and list every frontend location affected by each breaking change, graded DEFINITE / LIKELY / POSSIBLE. " +
        "Set `save` to make the new contract the baseline.",
      parameters: {
        backendDir: z.string().optional().describe("Backend root with the changes (defaults to the configured backend)"),
        save: z.boolean().default(false),
        format: reportFormat,
      },
      readOnly: false,
      run: async (a) => report(await ws.analyzeBackend(backendDir(a.backendDir), { save: a.save }), a.format),
    }),
    tool({
      name: "diff_api_changes",
      title: "Backend API changes between git refs",
      description:
        "Compare the backend API at two git refs (e.g. base `origin/main`, head omitted = working tree) and list the " +
        "frontend code affected by each breaking change. Skips extraction when the backend did not change.",
      parameters: {
        base: z.string().describe('Git ref the frontend was written against, e.g. "origin/main"'),
        head: z.string().optional().describe("Git ref with the change (default: working tree)"),
        backendDir: z.string().optional(),
        format: reportFormat,
      },
      readOnly: true,
      run: async (a) =>
        report(await ws.diffBackend(backendDir(a.backendDir), { base: a.base, head: a.head }), a.format,
          `Tacet: backend API changes ${a.base}...${a.head ?? "working tree"}`),
    }),
    tool({
      name: "verify_api_changes",
      title: "Verify API change impact with AI",
      description:
        "Run the backend change analysis (against the stored contract, or between git refs with `base`/`head`) and have " +
        "an AI model review only the findings static analysis could not decide (LIKELY / POSSIBLE), using just the " +
        "relevant code lines and before/after schemas. DEFINITE findings are never overridden; verdicts without evidence " +
        "from the provided code become UNKNOWN. Needs AI credentials (e.g. ANTHROPIC_API_KEY).",
      parameters: {
        backendDir: z.string().optional(),
        base: z.string().optional().describe("Compare git refs instead of the stored contract"),
        head: z.string().optional(),
        model: z.string().optional().describe("Model id (default: provider default)"),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
        format: reportFormat,
      },
      readOnly: true,
      run: async (a) => {
        const provider =
          options.aiProvider ?? createAiProvider(process.env.TACET_AI_PROVIDER ?? "anthropic", { model: a.model, effort: a.effort });
        const verified = await ws.verifyChanges(backendDir(a.backendDir), { provider, base: a.base, head: a.head });
        return report(verified, a.format, "Tacet: verified API change report");
      },
    }),
    tool({
      name: "impact_of_api",
      title: "Impact of changing an API",
      description:
        'Everything in the frontend that depends on an API, without changing anything: call sites (including through ' +
        'API client functions), response fields read and where, files and components. `api` accepts "GET /users/{id}", ' +
        '"GET /users/:id", or a path alone for all methods.',
      parameters: { api: z.string().describe('e.g. "GET /users/{id}"'), graph: graphOption },
      readOnly: true,
      run: async (a) => ws.impact().impactOfApi(a.api).map((i) => attachGraph(i, a.graph)),
    }),
    tool({
      name: "impact_of_file",
      title: "Impact of changing a frontend file",
      description:
        "What a change to this frontend file can affect: APIs it calls or reads, API client functions defined in it and " +
        "their callers, files importing it, and the blast radius (APIs, files, components).",
      parameters: { file: z.string().describe("Frontend file, relative to the frontend root or absolute"), graph: graphOption },
      readOnly: true,
      run: async (a) => attachGraph(ws.impact().impactOfFile(ws.toIndexPath(a.file)), a.graph),
    }),
    tool({
      name: "impact_of_field",
      title: "Impact of changing a response field",
      description:
        'Every endpoint that returns a DTO field and every frontend location reading it. `field` is "UserResponse.name", ' +
        'a nested path like "UserResponse.profile.email", or a fully qualified name.',
      parameters: { field: z.string().describe('e.g. "UserResponse.name"'), graph: graphOption },
      readOnly: true,
      run: async (a) => ws.impact().impactOfField(a.field).map((i) => attachGraph(i, a.graph)),
    }),
    tool({
      name: "search",
      title: "Search the Tacet index",
      description: "Search APIs, frontend files, functions, components, DTOs and fields; each hit reports how many APIs and files it touches.",
      parameters: { query: z.string().describe("Case-insensitive substring") },
      readOnly: true,
      run: async (a) => ws.impact().search(a.query),
    }),
    tool({
      name: "impact_summary",
      title: "Impact overview",
      description: "Rank every API by the number of frontend files and components using it, rank files by APIs used, and list backend endpoints no frontend code calls.",
      parameters: {},
      readOnly: true,
      run: async () => ws.impact().summary(),
    }),
    tool({
      name: "page_apis",
      title: "Which page uses which API",
      description:
        "Page ↔ API map. Pages come from React Router routes, Next.js / Remix file routes, `routes` in tacet.config.json, " +
        "or (without a router) components in pages/ views/ screens/ directories. For each page: the APIs it requests or " +
        "whose data it shows, the component → function chain leading there, and the response fields read. Pass `page` " +
        "(route or component) or `api` (e.g. \"GET /users/{id}\") to filter; with `api`, the result is grouped by API.",
      parameters: {
        page: z.string().optional().describe('Route or component, e.g. "/users/:id" or "UserPage" (substring match)'),
        api: z.string().optional().describe('API, e.g. "GET /users/{id}" or "/users" (substring match)'),
      },
      readOnly: true,
      run: async (a) => {
        const ontology = ws.ontology({ includeFiles: false });
        if (a.api) {
          const q = a.api.toLowerCase();
          return pagesByApi(ontology).filter((row) => row.apiKey.toLowerCase().includes(q));
        }
        if (!a.page) return ontology.pages;
        const q = a.page.toLowerCase();
        return ontology.pages.filter(
          (p) => (p.route ?? "").toLowerCase().includes(q) || p.component.toLowerCase().includes(q),
        );
      },
    }),
    tool({
      name: "ontology",
      title: "Project ontology",
      description:
        "The project as typed entities (Page, Component, Hook, ApiClient, Function, Endpoint, Controller, Dto, DtoField, Enum, " +
        "File) and subject–predicate–object triples (showsComponent, renders, calls, requests, reads, usesApi [inferred], " +
        "handledBy, accepts, returns, hasField, typedAs, definedIn) with file:line evidence. Use `focus` to get only the " +
        "neighborhood of an entity. Formats: json (entities + triples + page→API rows), mermaid, turtle (RDF/OWL for triple " +
        "stores and SPARQL), html (interactive explorer written to `outPath`).",
      parameters: {
        focus: z.string().optional().describe("Entity to center on: a route, component, function, API, controller or DTO"),
        depth: z.number().int().min(1).max(6).default(2).describe("With focus: relations to follow"),
        format: z.enum(["json", "mermaid", "turtle", "html"]).default("json"),
        includeFiles: z.boolean().default(false).describe("Include File entities and definedIn triples"),
        outPath: z.string().optional().describe("HTML output path (default .tacet/ontology.html)"),
      },
      readOnly: false,
      run: async (a) => {
        const ontology = ws.ontology({ focus: a.focus, depth: a.depth, includeFiles: a.includeFiles || a.format === "html" });
        if (a.focus && !findEntities(ontology, a.focus).length) {
          return { error: `No entity matches "${a.focus}". Try the search tool.`, stats: ontology.stats };
        }
        if (a.format === "mermaid") return { mermaid: renderOntologyMermaid(ontology), stats: ontology.stats };
        if (a.format === "turtle") return { turtle: renderOntologyTurtle(ontology), stats: ontology.stats };
        if (a.format === "html") {
          const out = resolve(a.outPath ?? ".tacet/ontology.html");
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, renderOntologyHtml(ontology, { title: `Tacet ontology${a.focus ? `: ${a.focus}` : ""}` }));
          return { path: out, stats: ontology.stats };
        }
        return ontology;
      },
    }),
    tool({
      name: "render_graph",
      title: "Render the impact graph",
      description:
        "Render the API → field → function/component → file graph, for the whole project or one api/file/field. " +
        '"mermaid" returns flowchart text; "html" writes an interactive page to `outPath` and returns its path.',
      parameters: {
        format: z.enum(["mermaid", "html"]).default("mermaid"),
        api: z.string().optional(),
        file: z.string().optional(),
        field: z.string().optional(),
        outPath: z.string().optional().describe("HTML output path (default .tacet/graph.html)"),
      },
      readOnly: false,
      run: async (a) => {
        const analyzer = ws.impact();
        const graph = a.api
          ? mergeGraphs(analyzer.impactOfApi(a.api).map((i) => i.graph))
          : a.file
            ? analyzer.impactOfFile(ws.toIndexPath(a.file)).graph
            : a.field
              ? mergeGraphs(analyzer.impactOfField(a.field).map((i) => i.graph))
              : analyzer.fullGraph();
        if (a.format === "mermaid") return { mermaid: renderMermaid(graph) };
        const out = resolve(a.outPath ?? ".tacet/graph.html");
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, renderHtml(graph, { title: `Tacet: ${a.api ?? a.file ?? a.field ?? "impact graph"}` }));
        return { path: out, nodes: graph.nodes.length, edges: graph.edges.length };
      },
    }),
  ];
}

function tool<Shape extends z.ZodRawShape>(definition: {
  name: string;
  title: string;
  description: string;
  parameters: Shape;
  readOnly: boolean;
  run: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>;
}): TacetTool {
  return {
    ...definition,
    parameters: z.object(definition.parameters),
    // Always reject asynchronously, even when argument defaults are missing.
    run: async (args: z.infer<z.ZodObject<Shape>>) => definition.run(args),
  } as unknown as TacetTool;
}

function report(value: ChangeReport | VerifiedChangeReport, format: "json" | "markdown", title?: string) {
  return format === "markdown" ? { result: value.result, markdown: renderChangeReportMarkdown(value, title) } : value;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`\`${name}\` is required (no default was configured for this server)`);
  return value;
}
