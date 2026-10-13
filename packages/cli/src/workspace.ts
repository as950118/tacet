import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  analyzeChangeImpact,
  analyzeUsage,
  buildOntology,
  checkContract,
  focusOntology,
  pagesByApi,
  verifyChangeReport,
  ImpactAnalyzer,
  DEFAULT_PROJECT,
  isPostgresUrl,
  loadConfig,
  openIndexDatabase,
  redactLocation,
  ProjectModel,
  type TacetConfig,
  type AiProvider,
  type ApiUsage,
  type BackendManifest,
  type ChangeReport,
  type ContractReport,
  type FrontendIndexUpdate,
  type IndexSummary,
  type ApiPages,
  type PageApis,
  type FrontendManifest,
  type IndexDatabase,
  type IndexStore,
  type Ontology,
  type OntologyEntity,
  type OntologyOptions,
  type OntologyTriple,
  type StoredPageApi,
  type UsageReport,
  type VerifiedChangeReport,
} from "@tacet-api/core";
import { JavaExtractor } from "@tacet-api/extractor-java";
import { TypeScriptProject } from "@tacet-api/extractor-typescript";
import { changedSourceFiles, hasChangesBetween, materializeAtRef } from "./git.js";

export const DEFAULT_INDEX_PATH = ".tacet/index.db";

export interface WorkspaceOptions {
  /** Project inside the index database (default "default"); one database can hold many frontends. */
  project?: string;
  /** An already open database to use (e.g. shared by the HTTP server across projects). The workspace never closes it. */
  database?: IndexDatabase;
}

export interface IndexFrontendOptions {
  configPath?: string;
  /** Also write the extracted manifest as JSON. */
  manifestPath?: string;
  /** Files that changed (relative to cwd or the frontend root). Scopes the report; the index is always kept consistent. */
  files?: string[];
  /** Git ref: use the TS files changed since it as `files`. */
  changedSince?: string;
}

export interface IndexFrontendResult extends FrontendIndexUpdate {
  indexPath: string;
  project: string;
  frontendDir: string;
  /** The changed files the caller asked about, relative to the frontend root; null for a full index. */
  scope: string[] | null;
  /** APIs used by the scope files (calls in them or response fields read in them). */
  apis: Pick<ApiUsage, "apiKey" | "status" | "handler">[];
}

export interface ExtractBackendOptions {
  /** Also write the manifest as JSON. */
  outPath?: string;
  jarPath?: string;
}

export interface ExtractBackendResult {
  indexPath: string;
  project: string;
  endpoints: number;
  dtos: number;
  enums: number;
  /** Feign / @HttpExchange client requests to other services. */
  serviceCalls: number;
  gatewayRoutes: number;
  warnings: string[];
  changedEndpoints: string[];
}

export interface AnalyzeBackendOptions {
  /** Store the new contract as the baseline afterwards. */
  save?: boolean;
  jarPath?: string;
}

export interface DiffBackendOptions {
  /** Git ref the frontend was written against, e.g. "origin/main". */
  base: string;
  /** Git ref with the backend change; the working tree when omitted. */
  head?: string;
  jarPath?: string;
}

export interface GitChangeReport extends ChangeReport {
  base: string;
  head: string;
  /** False when nothing under the backend directory changed between the refs (analysis skipped). */
  backendChanged: boolean;
}

export interface VerifyChangesOptions extends AnalyzeBackendOptions {
  provider: AiProvider;
  /** Compare git refs instead of the stored contract. */
  base?: string;
  head?: string;
  maxCandidatesPerEndpoint?: number;
  concurrency?: number;
}

export interface VerifiedGitChangeReport extends VerifiedChangeReport {
  base: string | null;
  head: string | null;
  backendChanged: boolean;
}

interface ChangeInputs {
  frontend: FrontendManifest;
  before: BackendManifest;
  after: BackendManifest;
  config: TacetConfig;
}

const EMPTY_CHANGE_REPORT: ChangeReport = {
  result: "PASS",
  endpoints: [],
  counts: { changedApis: 0, breakingChanges: 0, DEFINITE: 0, LIKELY: 0, POSSIBLE: 0 },
};

const EMPTY_BACKEND: BackendManifest = {
  language: "java", rootDir: "", generatedAt: "", endpoints: [], dtos: [], enums: [], warnings: [],
};

const EMPTY_INPUTS = {
  frontend: { language: "typescript", rootDir: "", generatedAt: "", files: [], functions: [], apiCalls: [], propertyAccesses: [] } as FrontendManifest,
  before: EMPTY_BACKEND,
  after: EMPTY_BACKEND,
};

export interface OntologyQueryOptions extends OntologyOptions {
  /** Only the neighborhood of entities matching this (a page route, component, API, DTO, …). */
  focus?: string;
  /** With `focus`: how many relations away from the matches to include (default 2). */
  depth?: number;
}

export interface RelationsQuery {
  /** A page: its route (e.g. "/users/:id") or entity id. Returns the APIs it uses. */
  page?: string;
  /** An API: "GET /users/{id}" or entity id. Returns the pages using it. */
  api?: string;
  /** Relations with this subject / predicate / object (entity id or exact label). */
  subject?: string;
  predicate?: string;
  object?: string;
  limit?: number;
}

export interface RelationsResult {
  /** The entities the query named (and those the results refer to), by id. */
  entities: Record<string, Pick<OntologyEntity, "class" | "label" | "file" | "line" | "status">>;
  relations: OntologyTriple[];
  pageApis: StoredPageApi[];
  /** With `page`: pages sharing the most non-common APIs with it. */
  relatedPages: Array<{ of: string; page: string; shared: number; apis: string[] }>;
}

export interface PageApisQuery {
  /** Pages whose route or component contains this (case-insensitive). */
  page?: string;
  /** APIs whose key contains this, e.g. "GET /users"; the result is then grouped by API. */
  api?: string;
}

export interface IndexStatus {
  indexPath: string;
  project: string;
  frontend: { rootDir: string; generatedAt: string } | null;
  backend: { rootDir: string; generatedAt: string } | null;
  summary: IndexSummary;
}

export interface CheckOptions {
  files?: string[];
  changedSince?: string;
}

/**
 * Library entry point used by the CLI and MCP servers. Holds the loaded
 * frontend project between calls so repeated updates only re-read the files
 * that changed.
 */
export class TacetWorkspace {
  /** The index location for display: a SQLite file path, or a PostgreSQL URL without its password. */
  readonly indexPath: string;
  readonly project: string;
  private readonly location: string;
  private database: Promise<IndexDatabase> | null;
  private ownsDatabase: boolean;
  private frontendProject: TypeScriptProject | null = null;

  /**
   * @param index a SQLite file path or a `postgres://` URL (tables go to the `tacet` schema, or `?schema=name`)
   */
  constructor(index: string = DEFAULT_INDEX_PATH, private readonly configPath?: string, options: WorkspaceOptions = {}) {
    this.location = isPostgresUrl(index) ? index : resolve(index);
    this.indexPath = options.database?.location ?? redactLocation(this.location);
    this.project = options.project ?? DEFAULT_PROJECT;
    this.database = options.database ? Promise.resolve(options.database) : null;
    this.ownsDatabase = !options.database;
  }

  /** Closes the index database (when this workspace opened it). The workspace reopens it on next use. */
  async close(): Promise<void> {
    const database = this.database;
    this.database = null;
    if (database && this.ownsDatabase) await (await database).close();
    else if (database) this.database = database;
  }

  async indexFrontend(frontendDir: string, options: IndexFrontendOptions = {}): Promise<IndexFrontendResult> {
    const root = resolve(frontendDir);
    if (!existsSync(root)) throw new Error(`Frontend directory not found: ${root}`);
    const config = this.resolveConfig(root, options.configPath);
    const scope = this.scopeFiles(root, options.files, options.changedSince);

    if (this.frontendProject?.root === root && scope) {
      this.frontendProject.refresh(scope);
    } else {
      this.frontendProject = TypeScriptProject.load(root, config);
    }
    const manifest = this.frontendProject.extract();
    if (options.manifestPath) writeJson(options.manifestPath, manifest);

    const update = await this.withStore(async (store) => {
      await store.writeConfig(config);
      const written = await store.writeManifest(manifest);
      await this.writeRelations(store);
      return written;
    });
    const apis = scope ? await this.apisUsedBy(scope) : [];
    return { ...update, indexPath: this.indexPath, project: this.project, frontendDir: root, scope, apis };
  }

  async extractBackend(backendDir: string, options: ExtractBackendOptions = {}): Promise<ExtractBackendResult> {
    const root = resolve(backendDir);
    if (!existsSync(root)) throw new Error(`Backend directory not found: ${root}`);
    const manifest = await new JavaExtractor({ jarPath: options.jarPath }).extract(root);
    if (options.outPath) writeJson(options.outPath, manifest);
    const update = await this.withStore(async (store) => {
      const written = await store.writeBackendManifest(manifest);
      await this.writeRelations(store);
      return written;
    });
    return {
      indexPath: this.indexPath,
      project: this.project,
      endpoints: update.endpoints,
      dtos: update.dtos,
      enums: manifest.enums.length,
      serviceCalls: manifest.serviceCalls?.length ?? 0,
      gatewayRoutes: manifest.gatewayRoutes?.length ?? 0,
      warnings: manifest.warnings,
      changedEndpoints: update.changedEndpoints,
    };
  }

  /** Phase 4+5: diff the stored backend contract against `backendDir` now, and find affected frontend code. */
  async analyzeBackend(backendDir: string, options: AnalyzeBackendOptions = {}): Promise<ChangeReport> {
    const inputs = await this.changeInputs(backendDir, options);
    return analyzeChangeImpact(inputs.frontend, inputs.before, inputs.after, inputs.config);
  }

  /** Phase 7: compare the backend at two git refs and find affected frontend code. */
  async diffBackend(backendDir: string, options: DiffBackendOptions): Promise<GitChangeReport> {
    const refs = { base: options.base, head: options.head ?? "working tree" };
    const inputs = await this.gitChangeInputs(backendDir, options);
    if (!inputs) return { ...refs, backendChanged: false, ...EMPTY_CHANGE_REPORT };
    return { ...refs, backendChanged: true, ...analyzeChangeImpact(inputs.frontend, inputs.before, inputs.after, inputs.config) };
  }

  /**
   * Phase 6: static change analysis (against the stored contract, or between git refs when `base` is given),
   * then AI verification of the findings static analysis could not decide.
   */
  async verifyChanges(backendDir: string, options: VerifyChangesOptions): Promise<VerifiedGitChangeReport> {
    const refs = options.base ? { base: options.base, head: options.head ?? "working tree" } : { base: null, head: null };
    const inputs = options.base
      ? await this.gitChangeInputs(backendDir, { ...options, base: options.base })
      : await this.changeInputs(backendDir, options);
    if (!inputs) {
      const empty = await verifyChangeReport(EMPTY_CHANGE_REPORT, EMPTY_INPUTS, options.provider, { readFile: () => null });
      return { ...refs, backendChanged: false, ...empty };
    }
    const report = analyzeChangeImpact(inputs.frontend, inputs.before, inputs.after, inputs.config);
    const root = inputs.frontend.rootDir;
    const verified = await verifyChangeReport(report, inputs, options.provider, {
      readFile: (path) => {
        const absolute = resolve(root, path);
        return absolute.startsWith(root + sep) && existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
      },
      maxCandidatesPerEndpoint: options.maxCandidatesPerEndpoint,
      concurrency: options.concurrency,
    });
    return { ...refs, backendChanged: true, ...verified };
  }

  private async changeInputs(backendDir: string, options: AnalyzeBackendOptions): Promise<ChangeInputs> {
    const root = resolve(backendDir);
    if (!existsSync(root)) throw new Error(`Backend directory not found: ${root}`);
    const { frontend, before, config } = await this.withStore(async (store) => ({
      frontend: await store.readFrontendManifest(),
      before: await store.readBackendManifest(),
      config: this.configPath ? loadConfig(this.configPath) : await store.readConfig(),
    }));
    if (!frontend) throw this.noFrontend();
    if (!before) {
      throw new Error("No baseline backend contract in the index. Run `tacet extract-backend <dir>` on the current backend first.");
    }
    const after = await new JavaExtractor({ jarPath: options.jarPath }).extract(root);
    if (options.save) {
      await this.withStore(async (store) => {
        await store.writeBackendManifest(after);
        await this.writeRelations(store);
      });
    }
    return { frontend, before, after, config };
  }

  /** null when nothing under the backend directory changed between the refs. */
  private async gitChangeInputs(backendDir: string, options: DiffBackendOptions): Promise<ChangeInputs | null> {
    const root = resolve(backendDir);
    const model = await this.model();
    if (!hasChangesBetween(root, options.base, options.head)) return null;
    const scratch = mkdtempSync(join(tmpdir(), "tacet-diff-"));
    try {
      const extractor = new JavaExtractor({ jarPath: options.jarPath });
      const beforeDir = materializeAtRef(root, options.base, join(scratch, "base"));
      const afterDir = options.head ? materializeAtRef(root, options.head, join(scratch, "head")) : root;
      const [before, after]: BackendManifest[] = await Promise.all([
        extractor.extract(beforeDir),
        extractor.extract(afterDir),
      ]);
      return { frontend: model.frontend, before, after, config: model.config };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async hasBackendBaseline(): Promise<boolean> {
    return this.withStore(async (store) => (await store.getMeta("backend.language")) !== null);
  }

  async model(): Promise<ProjectModel> {
    return this.withStore((store) => this.modelFrom(store));
  }

  private async modelFrom(store: IndexStore): Promise<ProjectModel> {
    const frontend = await store.readFrontendManifest();
    if (!frontend) throw this.noFrontend();
    const config = this.configPath ? loadConfig(this.configPath) : await store.readConfig();
    return new ProjectModel(frontend, await store.readBackendManifest(), config);
  }

  private noFrontend(): Error {
    const project = this.project === DEFAULT_PROJECT ? "" : ` (project "${this.project}")`;
    return new Error(`No frontend index in ${this.indexPath}${project}. Run \`tacet index <frontendDir>\` first.`);
  }

  /**
   * Keeps the relation tables (entities, relations, page_apis) in step with the facts: rebuilt from the
   * stored manifests after every write, with every frontend function kept (not only those leading to an API).
   */
  private async writeRelations(store: IndexStore): Promise<void> {
    if ((await store.getMeta("language")) === null) return;
    const model = await this.modelFrom(store);
    await store.writeRelations(buildOntology(model, { includeUnrelated: true }), model.config);
  }

  /** Queries the stored relations: a page's APIs, an API's pages, or relations by subject / predicate / object. */
  async relations(query: RelationsQuery): Promise<RelationsResult> {
    return this.withStore(async (store) => {
      // A different config (e.g. --config with another commonApis rule) rebuilds the stored relations.
      const config = this.configPath ? loadConfig(this.configPath) : await store.readConfig();
      if (!(await store.hasRelations()) || !(await store.relationsBuiltWith(config))) await this.writeRelations(store);
      const entities: RelationsResult["entities"] = {};
      const note = (e: OntologyEntity | null) => {
        if (e) entities[e.id] = { class: e.class, label: e.label, file: e.file, line: e.line, status: e.status };
      };
      const resolve = async (key: string, cls?: string): Promise<string[]> => {
        const found = await store.findEntitiesByKey(key, cls);
        if (!found.length) throw new Error(`No ${cls ?? "entity"} "${key}" in the index`);
        found.forEach(note);
        return found.map((e) => e.id);
      };
      const pageApis: StoredPageApi[] = [];
      const relatedPages: RelationsResult["relatedPages"] = [];
      if (query.page !== undefined) {
        for (const id of await resolve(query.page, "Page")) {
          pageApis.push(...(await store.pageApis({ page: id })));
          relatedPages.push(...(await store.relatedPages(id)).map((r) => ({ of: id, ...r })));
        }
      }
      if (query.api !== undefined) {
        const ids = (await store.findEntitiesByKey(query.api, "Endpoint")).length
          ? await resolve(query.api, "Endpoint")
          : await resolve(`api:${query.api}`, "Endpoint");
        for (const id of ids) pageApis.push(...(await store.pageApis({ endpoint: id })));
      }
      const relations: OntologyTriple[] = [];
      if (query.subject !== undefined || query.predicate !== undefined || query.object !== undefined) {
        const subjects = query.subject !== undefined ? await resolve(query.subject) : [undefined];
        const objects = query.object !== undefined ? await resolve(query.object) : [undefined];
        for (const subject of subjects) {
          for (const object of objects) {
            relations.push(...(await store.queryRelations({ subject, predicate: query.predicate, object, limit: query.limit })));
          }
        }
      }
      const ids = [
        ...relations.flatMap((t) => [t.subject, t.object]),
        ...pageApis.flatMap((u) => [u.page, u.endpoint]),
        ...relatedPages.map((r) => r.page),
      ];
      for (const id of new Set(ids)) if (!entities[id]) note(await store.getEntity(id));
      return { entities, relations, pageApis, relatedPages };
    });
  }

  /** Which page uses which API: every page, pages matching `page`, or (with `api`) the pages of each matching API. */
  async pageApis(query: PageApisQuery = {}): Promise<PageApis[] | ApiPages[]> {
    const ontology = await this.ontology({ includeFiles: false });
    if (query.api) {
      const q = query.api.toLowerCase();
      return pagesByApi(ontology).filter((row) => row.apiKey.toLowerCase().includes(q));
    }
    if (!query.page) return ontology.pages;
    const q = query.page.toLowerCase();
    return ontology.pages.filter((p) => (p.route ?? "").toLowerCase().includes(q) || p.component.toLowerCase().includes(q));
  }

  /** What the index holds for this project. */
  async status(): Promise<IndexStatus> {
    return this.withStore(async (store) => {
      const side = async (prefix: string) =>
        (await store.getMeta(`${prefix}language`)) === null
          ? null
          : { rootDir: (await store.getMeta(`${prefix}rootDir`)) ?? "", generatedAt: (await store.getMeta(`${prefix}generatedAt`)) ?? "" };
      return {
        indexPath: this.indexPath,
        project: this.project,
        frontend: await side(""),
        backend: await side("backend."),
        summary: await store.summary(),
      };
    });
  }

  /** Removes everything indexed for this project. */
  async clear(): Promise<void> {
    this.frontendProject = null;
    await this.withStore((store) => store.clear());
  }

  async check(options: CheckOptions = {}): Promise<ContractReport> {
    const model = await this.model();
    const files = this.scopeFiles(model.frontend.rootDir, options.files, options.changedSince);
    return checkContract(model, { files: files ?? undefined });
  }

  async impact(): Promise<ImpactAnalyzer> {
    return new ImpactAnalyzer(await this.model());
  }

  /** Pages, components, functions, APIs, controllers and DTOs, and how they connect (subject–predicate–object). */
  async ontology(options: OntologyQueryOptions = {}): Promise<Ontology> {
    const ontology = buildOntology(await this.model(), options);
    return options.focus ? focusOntology(ontology, options.focus, options.depth) : ontology;
  }

  /**
   * Who uses each backend endpoint: this index's frontend, the frontends of `otherIndexes` (other apps against
   * the same backend, each a database location) and of `otherProjects` (other projects in this database), and
   * backend services through Feign / @HttpExchange clients.
   */
  async usage(otherIndexes: string[] = [], otherProjects: string[] = []): Promise<UsageReport> {
    const others = [
      ...otherIndexes.map((index) => ({ ws: new TacetWorkspace(index), owned: true })),
      ...otherProjects.map((project) => ({ ws: this.forProject(project), owned: false })),
    ];
    const workspaces = [this, ...others.map((o) => o.ws)];
    try {
      const models = await Promise.all(workspaces.map((ws) => ws.model()));
      const frontendNames = models.map((m) => basename(m.frontend.rootDir));
      const names =
        new Set(frontendNames).size === models.length
          ? frontendNames
          : workspaces.map((ws) =>
              ws.project !== DEFAULT_PROJECT ? ws.project : basename(ws.indexPath).replace(/\.[^.]+$/, ""),
            );
      return analyzeUsage(models.map((model, i) => ({ name: names[i], model })));
    } finally {
      await Promise.all(others.filter((o) => o.owned).map((o) => o.ws.close()));
    }
  }

  /** A workspace for another project in the same database (sharing its connection). */
  forProject(project: string): TacetWorkspace {
    if (project === this.project) return this;
    const ws = new TacetWorkspace(this.location, this.configPath, { project });
    ws.database = this.open();
    ws.ownsDatabase = false;
    return ws;
  }

  /** Converts user-supplied paths (cwd-relative, absolute or root-relative) to index paths. */
  async toIndexPath(file: string, root?: string): Promise<string> {
    const frontendRoot = root ?? (await this.model()).frontend.rootDir;
    return toIndexPath(file, frontendRoot);
  }

  private scopeFiles(root: string, files?: string[], changedSince?: string): string[] | null {
    if (changedSince) return changedSourceFiles(root, changedSince);
    if (files?.length) return files.map((f) => toIndexPath(f, root));
    return null;
  }

  private async apisUsedBy(files: string[]): Promise<IndexFrontendResult["apis"]> {
    const analyzer = await this.impact();
    const apis = new Map<string, IndexFrontendResult["apis"][number]>();
    for (const file of files) {
      for (const api of analyzer.impactOfFile(file).apis) {
        apis.set(api.apiKey, { apiKey: api.apiKey, status: api.status, handler: api.handler });
      }
    }
    return [...apis.values()].sort((a, b) => a.apiKey.localeCompare(b.apiKey));
  }

  private resolveConfig(frontendRoot: string, configPath?: string): TacetConfig {
    const explicit = configPath ?? this.configPath;
    if (explicit) return loadConfig(explicit);
    const local = join(frontendRoot, "tacet.config.json");
    return existsSync(local) ? loadConfig(local) : {};
  }

  private open(): Promise<IndexDatabase> {
    if (this.database) return this.database;
    const opening = openIndexDatabase(this.location);
    // A failed open is retried on next use rather than cached.
    opening.catch(() => {
      if (this.database === opening) this.database = null;
    });
    this.database = opening;
    return opening;
  }

  private async withStore<T>(work: (store: IndexStore) => Promise<T>): Promise<T> {
    return work((await this.open()).project(this.project));
  }
}

/** Converts user-supplied paths (cwd-relative, absolute or root-relative) to index paths. */
function toIndexPath(file: string, frontendRoot: string): string {
  const absolute = isAbsolute(file) ? file : resolve(file);
  const insideRoot = absolute.startsWith(frontendRoot + sep);
  const rel = insideRoot && (existsSync(absolute) || !existsSync(join(frontendRoot, file)))
    ? relative(frontendRoot, absolute)
    : file.replace(/^\.\//, "");
  return rel.split(sep).join("/");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}
