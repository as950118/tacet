import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { Node, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from "ts-morph";
import type { RouteInfo, RouteSource, SourceLocation, TacetConfig } from "@tacet-api/core";
import { isFunctionLike, resolveFunctionNode, type FunctionLike } from "./analyzer.js";

export interface RouteContext {
  root: string;
  files: SourceFile[];
  config: TacetConfig;
  rel(sf: SourceFile): string;
  locationOf(node: Node): SourceLocation;
  functionId(fn: FunctionLike): string;
  functionName(fn: FunctionLike): string;
  isComponent(fn: FunctionLike): boolean;
}

const PAGE_DIRS = new Set(["pages", "views", "screens", "routes"]);
const COMPONENT_PROPS = ["element", "Component", "component", "lazy"];
const SOURCE_EXT = /\.(tsx|ts|jsx|js)$/;

/**
 * Finds the pages of a frontend: router declarations (React Router JSX and route objects), file-system
 * routing (Next.js, Remix / React Router framework mode) and `routes` from tacet.config.json. Only when
 * none of these exist are exported components in pages/ views/ screens/ directories taken as pages.
 */
export function extractRoutes(ctx: RouteContext): RouteInfo[] {
  const routes = new Map<string, RouteInfo>();
  const add = (route: RouteInfo | null): void => {
    if (route && !routes.has(route.id)) routes.set(route.id, route);
  };
  for (const file of ctx.files) {
    for (const node of file.getDescendants()) {
      if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) add(jsxRoute(ctx, node));
      else if (Node.isObjectLiteralExpression(node)) add(objectRoute(ctx, node));
    }
  }
  for (const route of fileSystemRoutes(ctx)) add(route);
  for (const route of configRoutes(ctx)) add(route);
  if (routes.size === 0) for (const route of conventionRoutes(ctx)) add(route);
  return [...routes.values()].sort(
    (a, b) => (a.path ?? "\uffff").localeCompare(b.path ?? "\uffff") || a.file.localeCompare(b.file) || a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// React Router
// ---------------------------------------------------------------------------

type JsxTag = import("ts-morph").JsxOpeningElement | import("ts-morph").JsxSelfClosingElement;

/** <Route path="users/:id" element={<UserPage />} />, nested inside parent <Route path> elements. */
function jsxRoute(ctx: RouteContext, tag: JsxTag): RouteInfo | null {
  if (!isRouteTag(tag)) return null;
  const component = attributeComponent(ctx, tag);
  if (!component) return null;
  const segments: (string | null)[] = [jsxRoutePath(tag)];
  for (const ancestor of tag.getAncestors()) {
    if (Node.isJsxElement(ancestor) && isRouteTag(ancestor.getOpeningElement())) {
      segments.unshift(jsxRoutePath(ancestor.getOpeningElement()));
    }
  }
  return route(ctx, tag, joinRoute(segments), component, "react-router");
}

function isRouteTag(tag: JsxTag): boolean {
  return /(^|\.)Route$/.test(tag.getTagNameNode().getText());
}

function jsxRoutePath(tag: JsxTag): string | null {
  const path = tag.getAttribute("path");
  if (Node.isJsxAttribute(path)) {
    const init = path.getInitializer();
    if (Node.isStringLiteral(init)) return init.getLiteralValue();
    if (Node.isJsxExpression(init)) return literal(init.getExpression());
    return null;
  }
  return tag.getAttribute("index") ? "" : null;
}

function attributeComponent(ctx: RouteContext, tag: JsxTag): ResolvedComponent | null {
  for (const name of COMPONENT_PROPS) {
    const attr = tag.getAttribute(name);
    if (!Node.isJsxAttribute(attr)) continue;
    const init = attr.getInitializer();
    const expr = Node.isJsxExpression(init) ? init.getExpression() : undefined;
    const component = expr ? componentFrom(ctx, expr) : null;
    if (component) return component;
  }
  return null;
}

/** { path: "users/:id", element: <UserPage /> } with `children` nested under parent route objects. */
function objectRoute(ctx: RouteContext, object: ObjectLiteralExpression): RouteInfo | null {
  const own = objectRoutePath(object);
  if (own === undefined) return null;
  let component: ResolvedComponent | null = null;
  for (const name of COMPONENT_PROPS) {
    const prop = object.getProperty(name);
    const init = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
    component = init ? componentFrom(ctx, init) : null;
    if (component) break;
  }
  if (!component) return null;

  const segments: (string | null)[] = [own];
  let current: Node = object;
  for (;;) {
    const array = current.getParent();
    const children = array?.getParent();
    const parent = children?.getParent();
    if (
      !Node.isArrayLiteralExpression(array) ||
      !Node.isPropertyAssignment(children) ||
      children.getName() !== "children" ||
      !Node.isObjectLiteralExpression(parent)
    ) {
      break;
    }
    segments.unshift(objectRoutePath(parent) ?? null);
    current = parent;
  }
  return route(ctx, object, joinRoute(segments), component, "react-router");
}

/** The route path of a route object; undefined when the object is not a route. */
function objectRoutePath(object: ObjectLiteralExpression): string | null | undefined {
  const path = object.getProperty("path");
  if (Node.isPropertyAssignment(path)) {
    const value = literal(path.getInitializer());
    return value ?? undefined;
  }
  const index = object.getProperty("index");
  return Node.isPropertyAssignment(index) && index.getInitializer()?.getText() === "true" ? "" : undefined;
}

// ---------------------------------------------------------------------------
// File-system routing, config and convention
// ---------------------------------------------------------------------------

function fileSystemRoutes(ctx: RouteContext): RouteInfo[] {
  const deps = dependencies(ctx.root);
  const next = deps.has("next");
  const remix = [...deps].some((d) => d.startsWith("@remix-run/") || d === "@react-router/dev");
  if (!next && !remix) return [];

  const routes: RouteInfo[] = [];
  for (const file of ctx.files) {
    const rel = ctx.rel(file);
    const path = (next ? nextRoute(rel) : null) ?? (remix ? remixRoute(rel) : null);
    if (path === null) continue;
    const component = defaultExportComponent(ctx, file);
    if (!component) continue;
    routes.push({
      id: `route:${rel}`,
      path,
      componentId: ctx.functionId(component.fn),
      component: component.name,
      source: "file-system",
      file: rel,
      location: ctx.locationOf(component.fn),
    });
  }
  return routes;
}

/** pages/users/[id].tsx → /users/[id]; app/(shop)/users/[id]/page.tsx → /users/[id]. */
export function nextRoute(rel: string): string | null {
  const pages = /^(?:src\/)?pages\/(.+)$/.exec(rel);
  if (pages && SOURCE_EXT.test(pages[1])) {
    const segments = pages[1].replace(SOURCE_EXT, "").split("/");
    if (segments[0] === "api" || segments.some((s) => s.startsWith("_"))) return null;
    if (segments.at(-1) === "index") segments.pop();
    return `/${segments.join("/")}`;
  }
  const app = /^(?:src\/)?app\/(?:(.*)\/)?page\.(tsx|ts|jsx|js)$/.exec(rel);
  if (app) {
    const segments = (app[1] ?? "").split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    return `/${segments.join("/")}`;
  }
  return null;
}

/** app/routes/users.$id.tsx → /users/:id; app/routes/_index.tsx → /; app/routes/users/route.tsx → /users. */
export function remixRoute(rel: string): string | null {
  const match = /^app\/routes\/(.+)$/.exec(rel);
  if (!match || !SOURCE_EXT.test(match[1])) return null;
  let name = match[1].replace(SOURCE_EXT, "");
  if (name.endsWith("/route")) name = name.slice(0, -"/route".length);
  else if (name.includes("/")) return null;
  const segments = name
    .split(".")
    .filter((s) => s !== "_index" && !s.startsWith("_"))
    .map((s) => s.replace(/_$/, "").replace(/^\$$/, "*").replace(/^\$/, ":").replace(/^\((.+)\)$/, "$1?"));
  return `/${segments.join("/")}`;
}

function configRoutes(ctx: RouteContext): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const [path, target] of Object.entries(ctx.config.routes ?? {})) {
    const [file, name] = target.split("#");
    const normalized = file.replace(/^\.\//, "");
    const sf = ctx.files.find((f) => ctx.rel(f) === normalized);
    if (!sf) continue;
    const component = name
      ? namedComponent(ctx, sf, name)
      : defaultExportComponent(ctx, sf) ?? onlyExportedComponent(ctx, sf);
    routes.push({
      id: `route:config:${path}`,
      path,
      componentId: component ? ctx.functionId(component.fn) : null,
      component: component?.name ?? name ?? normalized,
      source: "config",
      file: normalized,
      location: component ? ctx.locationOf(component.fn) : { file: normalized, line: 1, column: 1 },
    });
  }
  return routes;
}

function conventionRoutes(ctx: RouteContext): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const file of ctx.files) {
    const rel = ctx.rel(file);
    if (!rel.split("/").slice(0, -1).some((dir) => PAGE_DIRS.has(dir.toLowerCase()))) continue;
    for (const component of exportedComponents(ctx, file)) {
      routes.push({
        id: `route:${rel}#${component.name}`,
        path: null,
        componentId: ctx.functionId(component.fn),
        component: component.name,
        source: "convention",
        file: rel,
        location: ctx.locationOf(component.fn),
      });
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Component resolution
// ---------------------------------------------------------------------------

interface ResolvedComponent {
  fn: FunctionLike;
  name: string;
}

function route(
  ctx: RouteContext,
  node: Node,
  path: string,
  component: ResolvedComponent,
  source: RouteSource,
): RouteInfo {
  const location = ctx.locationOf(node);
  return {
    id: `route:${location.file}:${location.line}:${location.column}`,
    path,
    componentId: ctx.functionId(component.fn),
    component: component.name,
    source,
    file: location.file,
    location,
  };
}

/**
 * The page component a route value refers to: a JSX element (the innermost project component, so
 * `<RequireAuth><Dashboard /></RequireAuth>` is Dashboard), a component reference, a `React.lazy`
 * component, or a `lazy: () => import("./page")` module.
 */
function componentFrom(ctx: RouteContext, value: Node): ResolvedComponent | null {
  const expr = unwrapParens(value);
  if (Node.isJsxElement(expr) || Node.isJsxSelfClosingElement(expr) || Node.isJsxFragment(expr)) {
    const tags = [expr, ...expr.getDescendants()]
      .map((n) => (Node.isJsxElement(n) ? n.getOpeningElement() : n))
      .filter((n): n is JsxTag => Node.isJsxOpeningElement(n) || Node.isJsxSelfClosingElement(n));
    const resolved = tags
      .map((tag) => ({ tag, component: componentFrom(ctx, tag.getTagNameNode()) }))
      .filter((r): r is { tag: JsxTag; component: ResolvedComponent } => r.component !== null);
    const elementOf = (tag: JsxTag): Node => (Node.isJsxOpeningElement(tag) ? tag.getParentOrThrow() : tag);
    const leaf = resolved.find((r) => {
      const element = elementOf(r.tag);
      return !resolved.some((other) => other !== r && other.tag.getFirstAncestor((a) => a === element) !== undefined);
    });
    return leaf?.component ?? null;
  }
  if (Node.isIdentifier(expr) || Node.isPropertyAccessExpression(expr)) {
    const lazy = lazyTarget(expr);
    if (lazy) return lazyModuleComponent(ctx, lazy, expr.getText());
    const fn = resolveFunctionNode(expr);
    return fn ? { fn, name: expr.getText() } : null;
  }
  if (isFunctionLike(expr)) {
    const imported = importedModule(expr);
    if (imported) return lazyModuleComponent(ctx, imported, null);
  }
  return null;
}

/** For `const Page = lazy(() => import("./Page"))`: the import call. */
function lazyTarget(identifier: Node): Node | null {
  const symbol = identifier.getSymbol();
  const resolved = symbol?.isAlias() ? symbol.getAliasedSymbol() ?? symbol : symbol;
  for (const decl of resolved?.getDeclarations() ?? []) {
    if (!Node.isVariableDeclaration(decl)) continue;
    const init = decl.getInitializer();
    if (!Node.isCallExpression(init) || !/(^|\.)lazy$/.test(init.getExpression().getText())) continue;
    const loader = init.getArguments()[0];
    if (loader && isFunctionLike(loader)) return importedModule(loader);
  }
  return null;
}

/** `() => import("./Page")` → the import call. */
function importedModule(fn: FunctionLike): Node | null {
  return (
    fn
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => c.getExpression().getKind() === SyntaxKind.ImportKeyword) ?? null
  );
}

function lazyModuleComponent(ctx: RouteContext, importCall: Node, name: string | null): ResolvedComponent | null {
  if (!Node.isCallExpression(importCall)) return null;
  const specifier = literal(importCall.getArguments()[0]);
  if (!specifier?.startsWith(".")) return null;
  const from = ctx.rel(importCall.getSourceFile());
  const base = posix.normalize(posix.join(posix.dirname(from), specifier)).replace(SOURCE_EXT, "");
  const candidates = [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"].map((ext) => base + ext);
  const sf = ctx.files.find((f) => candidates.includes(ctx.rel(f)));
  if (!sf) return null;
  const component = defaultExportComponent(ctx, sf) ?? namedComponent(ctx, sf, "Component");
  if (!component) return null;
  return { ...component, name: name ?? (component.name === "Component" ? defaultName(ctx.rel(sf)) : component.name) };
}

function defaultExportComponent(ctx: RouteContext, sf: SourceFile): ResolvedComponent | null {
  const symbol = sf.getDefaultExportSymbol();
  for (const decl of symbol?.getDeclarations() ?? []) {
    let fn: FunctionLike | null = null;
    if (isFunctionLike(decl)) fn = decl;
    else if (Node.isExportAssignment(decl)) {
      const expr = unwrapParens(decl.getExpression());
      fn = isFunctionLike(expr) ? expr : resolveFunctionNode(expr);
      if (!fn && Node.isCallExpression(expr)) {
        // export default memo(Page) / withRouter(Page)
        const inner = expr.getArguments()[0];
        fn = inner ? (isFunctionLike(inner) ? inner : resolveFunctionNode(inner)) : null;
      }
    }
    if (fn) {
      const name = ctx.functionName(fn);
      return { fn, name: name === "default" || name === "<anonymous>" ? defaultName(ctx.rel(sf)) : name };
    }
  }
  return null;
}

function namedComponent(ctx: RouteContext, sf: SourceFile, name: string): ResolvedComponent | null {
  const fn = sf.getDescendants().filter(isFunctionLike).find((f) => ctx.functionName(f) === name);
  return fn ? { fn, name } : null;
}

function exportedComponents(ctx: RouteContext, sf: SourceFile): ResolvedComponent[] {
  const found = new Map<FunctionLike, ResolvedComponent>();
  for (const symbol of sf.getExportSymbols()) {
    for (const decl of symbol.getDeclarations()) {
      let fn: FunctionLike | null = null;
      if (isFunctionLike(decl)) fn = decl;
      else if (Node.isVariableDeclaration(decl) || Node.isExportAssignment(decl)) {
        const nameNode = Node.isVariableDeclaration(decl) ? decl.getNameNode() : decl.getExpression();
        fn = resolveFunctionNode(nameNode);
      }
      if (fn && ctx.isComponent(fn) && !found.has(fn)) {
        const name = ctx.functionName(fn);
        found.set(fn, { fn, name: name === "default" || name === "<anonymous>" ? defaultName(ctx.rel(sf)) : name });
      }
    }
  }
  return [...found.values()];
}

function onlyExportedComponent(ctx: RouteContext, sf: SourceFile): ResolvedComponent | null {
  const components = exportedComponents(ctx, sf);
  return components.length === 1 ? components[0] : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinRoute(segments: (string | null)[]): string {
  let path = "";
  for (const segment of segments) {
    if (segment === null || segment === "") continue;
    path = segment.startsWith("/") ? segment : `${path.replace(/\/$/, "")}/${segment}`;
  }
  return path.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1") || "/";
}

function literal(node: Node | undefined): string | null {
  return node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    ? node.getLiteralValue()
    : null;
}

function unwrapParens(node: Node): Node {
  let current = node;
  while (Node.isParenthesizedExpression(current) || Node.isAsExpression(current) || Node.isSatisfiesExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

/** src/pages/users/[id].tsx → "[id]"; .../page.tsx → its directory name. */
function defaultName(rel: string): string {
  const parts = rel.replace(SOURCE_EXT, "").split("/");
  const last = parts.pop()!;
  return (last === "page" || last === "route" || last === "index") && parts.length ? `${parts.at(-1)}/${last}` : last;
}

function dependencies(root: string): Set<string> {
  for (let dir = root; ; dir = dirname(dir)) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf8")) as Record<string, Record<string, string> | undefined>;
        return new Set([...Object.keys(json.dependencies ?? {}), ...Object.keys(json.devDependencies ?? {})]);
      } catch {
        return new Set();
      }
    }
    if (dirname(dir) === dir) return new Set();
  }
}
