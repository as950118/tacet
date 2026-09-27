import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  analyzeChangeImpact,
  checkContract,
  verifyChangeReport,
  ImpactAnalyzer,
  IndexStore,
  loadConfig,
  ProjectModel,
  type TacetConfig,
  type AiProvider,
  type ApiUsage,
  type BackendManifest,
  type ChangeReport,
  type ContractReport,
  type FrontendIndexUpdate,
  type FrontendManifest,
  type VerifiedChangeReport,
} from "@tacet-api/core";
import { JavaExtractor } from "@tacet-api/extractor-java";
import { TypeScriptProject } from "@tacet-api/extractor-typescript";
import { changedSourceFiles, hasChangesBetween, materializeAtRef } from "./git.js";

export const DEFAULT_INDEX_PATH = ".tacet/index.db";

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
  endpoints: number;
  dtos: number;
  enums: number;
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
  readonly indexPath: string;
  private project: TypeScriptProject | null = null;

  constructor(indexPath: string = DEFAULT_INDEX_PATH, private readonly configPath?: string) {
    this.indexPath = resolve(indexPath);
  }

  async indexFrontend(frontendDir: string, options: IndexFrontendOptions = {}): Promise<IndexFrontendResult> {
    const root = resolve(frontendDir);
    if (!existsSync(root)) throw new Error(`Frontend directory not found: ${root}`);
    const config = this.resolveConfig(root, options.configPath);
    const scope = this.scopeFiles(root, options.files, options.changedSince);

    if (this.project?.root === root && scope) {
      this.project.refresh(scope);
    } else {
      this.project = TypeScriptProject.load(root, config);
    }
    const manifest = this.project.extract();
    if (options.manifestPath) writeJson(options.manifestPath, manifest);

    const update = this.withStore((store) => {
      store.writeConfig(config);
      return store.writeManifest(manifest);
    });
    const apis = scope ? this.apisUsedBy(scope) : [];
    return { ...update, indexPath: this.indexPath, frontendDir: root, scope, apis };
  }

  async extractBackend(backendDir: string, options: ExtractBackendOptions = {}): Promise<ExtractBackendResult> {
    const root = resolve(backendDir);
    if (!existsSync(root)) throw new Error(`Backend directory not found: ${root}`);
    const manifest = await new JavaExtractor({ jarPath: options.jarPath }).extract(root);
    if (options.outPath) writeJson(options.outPath, manifest);
    const update = this.withStore((store) => store.writeBackendManifest(manifest));
    return {
      indexPath: this.indexPath,
      endpoints: update.endpoints,
      dtos: update.dtos,
      enums: manifest.enums.length,
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
    const { frontend, before, config } = this.withStore((store) => ({
      frontend: store.readFrontendManifest(),
      before: store.readBackendManifest(),
      config: this.configPath ? loadConfig(this.configPath) : store.readConfig(),
    }));
    if (!frontend) throw new Error(`No frontend index in ${this.indexPath}. Run \`tacet index <frontendDir>\` first.`);
    if (!before) {
      throw new Error("No baseline backend contract in the index. Run `tacet extract-backend <dir>` on the current backend first.");
    }
    const after = await new JavaExtractor({ jarPath: options.jarPath }).extract(root);
    if (options.save) this.withStore((store) => store.writeBackendManifest(after));
    return { frontend, before, after, config };
  }

  /** null when nothing under the backend directory changed between the refs. */
  private async gitChangeInputs(backendDir: string, options: DiffBackendOptions): Promise<ChangeInputs | null> {
    const root = resolve(backendDir);
    const model = this.model();
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

  hasBackendBaseline(): boolean {
    return this.withStore((store) => store.readBackendManifest() !== null);
  }

  model(): ProjectModel {
    return this.withStore((store) => {
      const frontend = store.readFrontendManifest();
      if (!frontend) throw new Error(`No frontend index in ${this.indexPath}. Run \`tacet index <frontendDir>\` first.`);
      const config = this.configPath ? loadConfig(this.configPath) : store.readConfig();
      return new ProjectModel(frontend, store.readBackendManifest(), config);
    });
  }

  check(options: CheckOptions = {}): ContractReport {
    const model = this.model();
    const files = this.scopeFiles(model.frontend.rootDir, options.files, options.changedSince);
    return checkContract(model, { files: files ?? undefined });
  }

  impact(): ImpactAnalyzer {
    return new ImpactAnalyzer(this.model());
  }

  /** Converts user-supplied paths (cwd-relative, absolute or root-relative) to index paths. */
  toIndexPath(file: string, root?: string): string {
    const frontendRoot = root ?? this.model().frontend.rootDir;
    const absolute = isAbsolute(file) ? file : resolve(file);
    const insideRoot = absolute.startsWith(frontendRoot + sep);
    const rel = insideRoot && (existsSync(absolute) || !existsSync(join(frontendRoot, file)))
      ? relative(frontendRoot, absolute)
      : file.replace(/^\.\//, "");
    return rel.split(sep).join("/");
  }

  private scopeFiles(root: string, files?: string[], changedSince?: string): string[] | null {
    if (changedSince) return changedSourceFiles(root, changedSince);
    if (files?.length) return files.map((f) => this.toIndexPath(f, root));
    return null;
  }

  private apisUsedBy(files: string[]): IndexFrontendResult["apis"] {
    const analyzer = this.impact();
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

  private withStore<T>(work: (store: IndexStore) => T): T {
    mkdirSync(dirname(this.indexPath), { recursive: true });
    const store = IndexStore.open(this.indexPath);
    try {
      return work(store);
    } finally {
      store.close();
    }
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}
