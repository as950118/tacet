import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type CallExpression,
  type ElementAccessExpression,
  type PropertyAccessExpression,
  type ResolutionHost,
  type SourceFile,
} from "ts-morph";
import {
  loadConfig,
  type TacetConfig,
  type FileInfo,
  type FrontendManifest,
  type LanguageExtractor,
  type PropertyAccessInfo,
  type SourceLocation,
} from "@tacet-api/core";
import {
  DataFlowAnalyzer,
  isBody,
  isFunctionLike,
  nodeLocation,
  resolveFunctionNode,
  type FunctionLike,
  type TrackedValue,
} from "./analyzer.js";
import { extractRoutes } from "./routes.js";

const MAX_CODE_LENGTH = 200;

export interface TypeScriptExtractOptions {
  configPath?: string;
  config?: TacetConfig;
}

export class TypeScriptExtractor implements LanguageExtractor<FrontendManifest> {
  readonly language = "typescript" as const;

  async extract(rootDir: string, options: TypeScriptExtractOptions = {}): Promise<FrontendManifest> {
    return extractTypeScriptManifest(rootDir, options.config ?? loadConfig(options.configPath));
  }
}

export function extractTypeScriptManifest(
  rootDir: string,
  config: TacetConfig = {},
): FrontendManifest {
  return TypeScriptProject.load(rootDir, config).extract();
}

/**
 * A loaded frontend project. Long-lived callers (e.g. an MCP server) keep one
 * instance and call `refresh()` with changed files instead of reloading, so
 * unchanged files keep their parsed ASTs.
 */
export class TypeScriptProject {
  private constructor(
    readonly root: string,
    private readonly project: Project,
    private readonly config: TacetConfig,
  ) {}

  static load(rootDir: string, config: TacetConfig = {}): TypeScriptProject {
    const root = resolve(rootDir);
    return new TypeScriptProject(root, loadProject(root), config);
  }

  /** Re-reads files from disk, picking up edits, new files and deletions. Paths may be relative to the root. */
  refresh(paths: string[]): void {
    for (const path of paths) {
      const absolute = isAbsolute(path) ? path : join(this.root, path);
      const existing = this.project.getSourceFile(absolute);
      if (!existsSync(absolute)) {
        if (existing) this.project.removeSourceFile(existing);
      } else if (existing) {
        existing.refreshFromFileSystemSync();
      } else if (isSourcePath(absolute)) {
        this.project.addSourceFileAtPath(absolute);
      }
    }
  }

  extract(): FrontendManifest {
    return extractFrom(this.root, sourceFiles(this.project), this.config);
  }
}

function extractFrom(root: string, files: SourceFile[], config: TacetConfig): FrontendManifest {
  const rel = (sf: SourceFile): string => relative(root, sf.getFilePath()).split(sep).join("/");

  const locationOf = (node: Node): SourceLocation => ({
    file: rel(node.getSourceFile()),
    ...nodeLocation(node),
  });
  const idOf = (prefix: string, node: Node): string => {
    const { file, line, column } = locationOf(node);
    return `${prefix}:${file}:${line}:${column}`;
  };
  // Chained calls (`axios.get(url).then(...)`) share a start position, so key calls by where the callee ends.
  const callIdOf = (call: CallExpression): string => {
    const sf = call.getSourceFile();
    const { line, column } = sf.getLineAndColumnAtPos(call.getExpression().getEnd());
    return `call:${rel(sf)}:${line}:${column}`;
  };
  const functionIdOf = (node: Node): string | null => {
    const fn = isFunctionLike(node) ? node : node.getFirstAncestor(isFunctionLike);
    return fn ? idOf("fn", fn) : null;
  };

  const analyzer = new DataFlowAnalyzer(config, callIdOf, loadEnv(root, config));
  analyzer.propagate(files);

  const manifest: FrontendManifest = {
    language: "typescript",
    rootDir: root,
    generatedAt: new Date().toISOString(),
    files: [],
    functions: [],
    apiCalls: [],
    propertyAccesses: [],
    routes: [],
  };
  const accesses = new Map<string, PropertyAccessInfo>();
  const recordAccess = (node: Node, value: TrackedValue, object: string, code: string): void => {
    const id = idOf("prop", node);
    accesses.set(id, {
      id,
      apiCallId: value.apiCallId,
      object: truncate(object),
      path: value.path,
      flow: value.flow,
      file: rel(node.getSourceFile()),
      location: locationOf(node),
      containingFunctionId: functionIdOf(node),
      containingComponent: componentOf(node),
      code: truncate(code),
      ...fallbackGroupOf(node, idOf),
    });
  };

  for (const file of files) {
    manifest.files.push(fileInfo(file, rel, locationOf));

    const callsByFunction = new Map<string, Set<string>>();
    const invokesByFunction = new Map<string, Set<string>>();
    const rendersByFunction = new Map<string, Set<string>>();
    const addTo = (map: Map<string, Set<string>>, owner: string, value: string): void => {
      (map.get(owner) ?? map.set(owner, new Set()).get(owner)!).add(value);
    };
    file.forEachDescendant((node) => {
      if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
        const owner = functionIdOf(node);
        const component = resolveFunctionNode(node.getTagNameNode());
        if (owner && component) addTo(rendersByFunction, owner, idOf("fn", component));
      }
      if (Node.isCallExpression(node)) {
        const owner = functionIdOf(node);
        if (owner) {
          addTo(callsByFunction, owner, truncate(node.getExpression().getText()));
          const callee = resolveFunctionNode(node.getExpression());
          if (callee) addTo(invokesByFunction, owner, idOf("fn", callee));
        }
        const target = analyzer.classifyCall(node);
        if (target) {
          manifest.apiCalls.push({
            id: callIdOf(node),
            endpointPattern: target.endpoint.pattern,
            method: target.endpoint.method,
            calleeExpression: truncate(node.getExpression().getText()),
            resolution: target.resolution,
            wrapperFunctionId: target.wrapper ? idOf("fn", target.wrapper) : null,
            callerFunctionId: functionIdOf(node),
            file: rel(file),
            location: locationOf(node),
            arguments: node.getArguments().map((a) => truncate(a.getText())),
            request: target.request,
            returnVarType: boundVariableType(node),
            code: truncate(node.getText()),
          });
        }
      }

      if (isOutermostMemberAccess(node)) {
        // For `user.name.toUpperCase()` the accessed field is `user.name`, not `toUpperCase`.
        const parent = node.getParent();
        const target =
          Node.isCallExpression(parent) && parent.getExpression() === node
            ? (node as PropertyAccessExpression | ElementAccessExpression).getExpression()
            : node;
        const value = analyzer.evaluate(target);
        if (isBody(value) && value.path.length > 0) {
          recordAccess(target, value, memberRoot(target).getText(), target.getText());
        }
      }
    });

    for (const fn of file.getDescendants().filter(isFunctionLike)) {
      const id = idOf("fn", fn);
      manifest.functions.push({
        id,
        name: functionName(fn),
        file: rel(file),
        params: fn.getParameters().map((p) => ({
          name: p.getName(),
          type: p.getTypeNode()?.getText() ?? null,
        })),
        returnType: fn.getReturnTypeNode()?.getText() ?? null,
        calls: [...(callsByFunction.get(id) ?? [])],
        location: locationOf(fn),
        containingComponent: componentOf(fn),
        parentId: functionIdOf(fn.getParentOrThrow()),
        invokes: [...(invokesByFunction.get(id) ?? [])].filter((target) => target !== id),
        renders: [...(rendersByFunction.get(id) ?? [])],
      });
    }
  }

  for (const access of analyzer.recordedDestructuringAccesses) {
    recordAccess(access.node, access.value, access.object, firstLine(access.code));
  }

  manifest.routes = extractRoutes({
    root,
    files,
    config,
    rel,
    locationOf,
    functionId: (fn) => idOf("fn", fn),
    functionName,
    isComponent,
  });

  const apiCallIds = new Set(manifest.apiCalls.map((c) => c.id));
  manifest.propertyAccesses = [...accesses.values()]
    .filter((a) => apiCallIds.has(a.apiCallId))
    .sort((a, b) =>
      a.file === b.file
        ? a.location.line - b.location.line || a.location.column - b.location.column
        : a.file.localeCompare(b.file),
    );
  return manifest;
}

function loadProject(root: string): Project {
  const tsConfigFilePath = join(root, "tsconfig.json");
  if (existsSync(tsConfigFilePath)) return new Project({ tsConfigFilePath });
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    resolutionHost: (host, getCompilerOptions) => nearestTsconfigResolution(root, host, getCompilerOptions),
  });
  project.addSourceFilesAtPaths([`${root}/**/*.{ts,tsx}`, `!${root}/**/node_modules/**`]);
  return project;
}

const NESTED_TSCONFIG_NAMES = ["tsconfig.json", "tsconfig.base.json"];

/**
 * Monorepos (Nx, pnpm workspaces) often have no root tsconfig.json; each package declares its own `paths`
 * (`@shared-api` → `../../libs/shared/api/src`). Resolve every import with the `paths`/`baseUrl` of the
 * tsconfig nearest to the importing file, so an alias means what it means in that package.
 */
function nearestTsconfigResolution(
  root: string,
  host: ts.ModuleResolutionHost,
  getCompilerOptions: () => ts.CompilerOptions,
): ResolutionHost {
  const optionsByDir = new Map<string, ts.CompilerOptions | null>();
  const parseHost: ts.ParseConfigFileHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };

  const tsconfigOptions = (dir: string): ts.CompilerOptions | null => {
    if (optionsByDir.has(dir)) return optionsByDir.get(dir)!;
    let options: ts.CompilerOptions | null = null;
    const configPath = NESTED_TSCONFIG_NAMES.map((name) => join(dir, name)).find((p) => existsSync(p));
    if (configPath) {
      const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, parseHost);
      if (parsed?.options.paths || parsed?.options.baseUrl) {
        const { baseUrl, paths, pathsBasePath } = parsed.options;
        options = { baseUrl, paths, pathsBasePath };
      }
    }
    if (!options) {
      const parent = dirname(dir);
      options = dir !== root && parent !== dir && !relative(root, parent).startsWith("..") ? tsconfigOptions(parent) : null;
    }
    optionsByDir.set(dir, options);
    return options;
  };

  let packages: Map<string, WorkspacePackage> | undefined;
  const resolveWorkspaceImport = (name: string, containingFile: string, options: ts.CompilerOptions) => {
    packages ??= workspacePackages(root);
    const match = [...packages.values()].find((p) => name === p.name || name.startsWith(`${p.name}/`));
    if (!match) return undefined;
    const subpath = name.slice(match.name.length + 1);
    const candidates = subpath ? [subpath] : [...match.entries, "src/index", "index"];
    for (const candidate of candidates) {
      const target = join(match.dir, candidate.replace(/\.(d\.)?[cm]?[jt]sx?$/, ""));
      const resolved = ts.resolveModuleName(target, containingFile, options, host).resolvedModule;
      if (resolved) return resolved;
    }
    return undefined;
  };

  return {
    resolveModuleNames: (moduleNames, containingFile) => {
      const options = { ...getCompilerOptions(), ...tsconfigOptions(dirname(containingFile)) };
      return moduleNames.map(
        (name) =>
          ts.resolveModuleName(name, containingFile, options, host).resolvedModule ??
          resolveWorkspaceImport(name, containingFile, options),
      );
    },
  };
}

interface WorkspacePackage {
  name: string;
  dir: string;
  /** `types`/`main`/`module` entries from package.json, tried in order. */
  entries: string[];
}

const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "coverage", "tmp"]);

/**
 * Packages of a pnpm/npm/yarn workspace (`"@shared-api": "workspace:*"`), found by their package.json, so
 * imports between them resolve to source even when node_modules is not installed (e.g. in CI).
 */
function workspacePackages(root: string): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  const visit = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) {
        visit(join(dir, entry.name));
      } else if (entry.name === "package.json" && dir !== root) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, entry.name), "utf8")) as Record<string, unknown>;
          if (typeof pkg.name !== "string" || packages.has(pkg.name)) continue;
          const fields = [pkg.types, pkg.typings, pkg.module, pkg.main];
          packages.set(pkg.name, {
            name: pkg.name,
            dir,
            entries: fields.filter((f): f is string => typeof f === "string"),
          });
        } catch {
          // not a usable package.json
        }
      }
    }
  };
  visit(root);
  return packages;
}

/** `envFiles` (dotenv, relative to the frontend root) in order, then `env`. */
function loadEnv(root: string, config: TacetConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of config.envFiles ?? []) {
    const path = isAbsolute(file) ? file : join(root, file);
    if (!existsSync(path)) throw new Error(`Env file not found: ${path}`);
    Object.assign(env, parseDotenv(readFileSync(path, "utf8")));
  }
  return { ...env, ...config.env };
}

function parseDotenv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    const quoted = value.match(/^(["'`])(.*)\1$/);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, "");
    env[match[1]] = value;
  }
  return env;
}

/**
 * The outermost `??` / `||` chain a read is an operand of, looking through parentheses, casts and one
 * wrapping call (`num(a.memoryGb) ?? num(a.memory_gb)`).
 */
function fallbackGroupOf(
  node: Node,
  idOf: (prefix: string, node: Node) => string,
): { fallbackGroup: string } | Record<string, never> {
  let current = node;
  let chain: Node | null = null;
  let crossedCall = false;
  for (;;) {
    const parent = current.getParent();
    if (!parent) break;
    if (
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isNonNullExpression(parent) ||
      Node.isSatisfiesExpression(parent)
    ) {
      current = parent;
    } else if (Node.isCallExpression(parent) && !crossedCall && parent.getArguments().includes(current)) {
      crossedCall = true;
      current = parent;
    } else if (
      Node.isBinaryExpression(parent) &&
      [SyntaxKind.QuestionQuestionToken, SyntaxKind.BarBarToken].includes(parent.getOperatorToken().getKind())
    ) {
      chain = parent;
      crossedCall = false;
      current = parent;
    } else {
      break;
    }
  }
  return chain ? { fallbackGroup: idOf("fallback", chain) } : {};
}

function isSourcePath(path: string): boolean {
  return /\.tsx?$/.test(path) && !path.endsWith(".d.ts") && !path.includes(`${sep}node_modules${sep}`);
}

function sourceFiles(project: Project): SourceFile[] {
  return project
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile() && !sf.getFilePath().includes("/node_modules/"));
}

function fileInfo(
  file: SourceFile,
  rel: (sf: SourceFile) => string,
  locationOf: (node: Node) => SourceLocation,
): FileInfo {
  return {
    path: rel(file),
    imports: file.getImportDeclarations().map((decl) => {
      const target = decl.getModuleSpecifierSourceFile();
      return {
      source: decl.getModuleSpecifierValue(),
      resolvedFile:
        target && !target.isDeclarationFile() && !target.getFilePath().includes("/node_modules/")
          ? rel(target)
          : null,
      specifiers: [
        ...(decl.getDefaultImport() ? [decl.getDefaultImport()!.getText()] : []),
        ...(decl.getNamespaceImport() ? [`* as ${decl.getNamespaceImport()!.getText()}`] : []),
        ...decl.getNamedImports().map((n) => n.getName()),
      ],
      location: locationOf(decl),
      };
    }),
    exports: file.getExportSymbols().map((s) => s.getName()),
  };
}

function isOutermostMemberAccess(node: Node): boolean {
  if (!Node.isPropertyAccessExpression(node) && !Node.isElementAccessExpression(node)) return false;
  const parent = node.getParent();
  return !(
    (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) &&
    parent.getExpression() === node
  );
}

function memberRoot(node: Node): Node {
  let current = node;
  while (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

function functionName(fn: FunctionLike): string {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    return fn.getName() ?? "default";
  }
  if (Node.isFunctionExpression(fn) && fn.getName()) return fn.getName()!;
  let parent: Node | undefined = fn.getParent();
  // const UserCard = memo(() => ...)
  if (Node.isCallExpression(parent)) parent = parent.getParent();
  if (Node.isVariableDeclaration(parent)) return parent.getName();
  if (Node.isPropertyAssignment(parent)) {
    // export const userApi = { getUser: () => ... }  ->  "userApi.getUser"
    const owner = parent.getParent().getParent();
    return Node.isVariableDeclaration(owner) ? `${owner.getName()}.${parent.getName()}` : parent.getName();
  }
  return "<anonymous>";
}

function isComponent(fn: FunctionLike): boolean {
  return (
    /^[A-Z]/.test(functionName(fn)) &&
    (fn.getFirstDescendantByKind(SyntaxKind.JsxElement) !== undefined ||
      fn.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) !== undefined ||
      fn.getFirstDescendantByKind(SyntaxKind.JsxFragment) !== undefined)
  );
}

function componentOf(node: Node): string | null {
  let fn: FunctionLike | undefined = isFunctionLike(node) ? node : node.getFirstAncestor(isFunctionLike);
  while (fn) {
    if (isComponent(fn)) return functionName(fn);
    fn = fn.getFirstAncestor(isFunctionLike);
  }
  return null;
}

function boundVariableType(call: CallExpression): string | null {
  let node: Node = call;
  while (Node.isAwaitExpression(node.getParent()) || Node.isParenthesizedExpression(node.getParent())) {
    node = node.getParentOrThrow();
  }
  const decl = node.getParent();
  if (!Node.isVariableDeclaration(decl) || decl.getInitializer() !== node) return null;
  const typeText = decl.getType().getText(decl);
  return typeText === "any" ? null : truncate(typeText);
}

function firstLine(text: string): string {
  return text.split("\n")[0].trim();
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_CODE_LENGTH ? `${oneLine.slice(0, MAX_CODE_LENGTH - 1)}…` : oneLine;
}
