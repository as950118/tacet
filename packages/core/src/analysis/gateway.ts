import type { EndpointInfo, GatewayRouteInfo } from "../ir/types.js";
import { normalizePath, PARAM_PLACEHOLDER } from "../path.js";

const REST = "__tacet_rest__";
const SEGMENT = "__tacet_segment__";

/** A gateway path pattern as it reaches the backend: segments, where "**" (last only) matches any rest. */
export interface ForwardedPattern {
  route: string;
  pattern: string;
  segments: string[];
}

/**
 * The backend-side path patterns a gateway forwards to: each route's Path predicates after its StripPrefix,
 * RewritePath and PrefixPath filters, with the servlet context path removed.
 */
export function forwardedPatterns(routes: GatewayRouteInfo[], contextPaths: string[] = []): ForwardedPattern[] {
  const patterns: ForwardedPattern[] = [];
  routes.forEach((route, i) => {
    for (const predicate of route.paths) {
      let path = toSentinels(predicate);
      if (route.stripPrefix > 0) path = `/${path.split("/").filter(Boolean).slice(route.stripPrefix).join("/")}`;
      for (const rewrite of route.rewrites) path = applyRewrite(path, rewrite.regex, rewrite.replacement);
      if (route.prefixPath) path = `${route.prefixPath}/${path}`;
      const pattern = withoutContextPath(fromSentinels(normalizePath(path)), contextPaths);
      patterns.push({ route: route.id ?? `route ${i + 1}`, pattern, segments: pattern.split("/").filter(Boolean) });
    }
  });
  return patterns;
}

/** Routes that forward requests to the endpoint (empty when none does). */
export function routesTo(endpoint: EndpointInfo, patterns: ForwardedPattern[], backendBasePath?: string): string[] {
  const base = backendBasePath ? normalizePath(backendBasePath).split("/").filter(Boolean) : [];
  // Raw segments keep path variable constraints, e.g. {userType:admin|user} accepts "admin" but not "custom".
  const segments = [...base, ...endpoint.path.split("?")[0].split("/").filter(Boolean)];
  return [...new Set(patterns.filter((p) => matches(p.segments, segments)).map((p) => p.route))];
}

function matches(pattern: string[], path: string[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const segment = pattern[i];
    if (segment === "**") return true;
    if (i >= path.length) return false;
    if (segment === "*" || segment === PARAM_PLACEHOLDER) continue;
    const variable = /^\{[^}:]*(?::(.*))?\}$/.exec(path[i]);
    if (variable) {
      if (variable[1] !== undefined && !acceptsLiteral(variable[1], segment)) return false;
      continue;
    }
    if (segment !== path[i]) return false;
  }
  return pattern.length === path.length;
}

function acceptsLiteral(regex: string, literal: string): boolean {
  try {
    return new RegExp(`^(?:${regex})$`).test(literal);
  } catch {
    return true;
  }
}

/** "/a/{id}/**" → "/a/__tacet_segment__/__tacet_rest__", so a regex rewrite can move the wildcards along. */
function toSentinels(pattern: string): string {
  return pattern
    .split("/")
    .map((s) => (s === "**" ? REST : s === "*" || /^\{[^}]*\}$/.test(s) ? SEGMENT : s))
    .join("/");
}

function fromSentinels(path: string): string {
  return path
    .split("/")
    .map((s) => (s === REST ? "**" : s === SEGMENT ? PARAM_PLACEHOLDER : s))
    .join("/");
}

/** Java regex + replacement (`${name}`, `$\{name}` as escaped in YAML, `$1`) applied with JavaScript's RegExp. */
function applyRewrite(path: string, regex: string, replacement: string): string {
  let pattern: RegExp;
  try {
    pattern = new RegExp(regex);
  } catch {
    return path; // Java-only regex syntax: leave the path as is.
  }
  return path.replace(pattern, replacement.replace(/\$\\?\{(\w+)\}/g, "$$<$1>"));
}

function withoutContextPath(pattern: string, contextPaths: string[]): string {
  for (const prefix of contextPaths.map(normalizePath).sort((a, b) => b.length - a.length)) {
    if (prefix === "/") continue;
    if (pattern === prefix) return "/";
    if (pattern.startsWith(`${prefix}/`)) return pattern.slice(prefix.length);
  }
  return pattern;
}
