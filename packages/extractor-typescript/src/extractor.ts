import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type CallExpression,
  type ElementAccessExpression,
  type PropertyAccessExpression,
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
  isFunctionLike,
  nodeLocation,
  type FunctionLike,
  type TrackedValue,
} from "./analyzer.js";

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

  const analyzer = new DataFlowAnalyzer(config, callIdOf);
  analyzer.propagate(files);

  const manifest: FrontendManifest = {
    language: "typescript",
    rootDir: root,
    generatedAt: new Date().toISOString(),
    files: [],
    functions: [],
    apiCalls: [],
    propertyAccesses: [],
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
    });
  };

  for (const file of files) {
    manifest.files.push(fileInfo(file, rel, locationOf));

    const callsByFunction = new Map<string, Set<string>>();
    file.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const owner = functionIdOf(node);
        if (owner) {
          const set = callsByFunction.get(owner) ?? new Set<string>();
          set.add(truncate(node.getExpression().getText()));
          callsByFunction.set(owner, set);
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
        if (value?.kind === "body" && value.path.length > 0) {
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
      });
    }
  }

  for (const access of analyzer.recordedDestructuringAccesses) {
    recordAccess(access.node, access.value, access.object, firstLine(access.code));
  }

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
  });
  project.addSourceFilesAtPaths([`${root}/**/*.{ts,tsx}`, `!${root}/**/node_modules/**`]);
  return project;
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
