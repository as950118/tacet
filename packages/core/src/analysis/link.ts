import type { LinkingConfig } from "../config.js";
import type { ApiCallInfo, EndpointInfo } from "../ir/types.js";
import { joinPath, normalizePath, PARAM_PLACEHOLDER } from "../path.js";

/**
 * - matched:         method + path match a backend endpoint
 * - method-mismatch: the path exists in the backend, but not for this HTTP method
 * - not-found:       no backend endpoint has a compatible path
 * - unresolved:      the frontend URL could not be determined statically
 */
export type LinkStatus = "matched" | "method-mismatch" | "not-found" | "unresolved";

export interface ApiLink {
  apiCallId: string;
  status: LinkStatus;
  endpointId: string | null;
  /** method-mismatch: endpoints on the same path. not-found: most similar endpoints. */
  candidates: string[];
}

interface PreparedEndpoint {
  endpoint: EndpointInfo;
  segments: string[];
}

/** Links frontend API calls to backend endpoints by method + normalized path. */
export class EndpointLinker {
  private readonly endpoints: PreparedEndpoint[];

  constructor(
    endpoints: EndpointInfo[],
    private readonly linking: LinkingConfig = {},
  ) {
    this.endpoints = endpoints.map((endpoint) => ({
      endpoint,
      segments: segmentsOf(joinPath(linking.backendBasePath, normalizePath(endpoint.path))),
    }));
  }

  link(call: ApiCallInfo): ApiLink {
    const base = { apiCallId: call.id, endpointId: null, candidates: [] };
    if (call.endpointPattern === null || call.method === null) return { ...base, status: "unresolved" };

    const segments = segmentsOf(this.frontendPath(call.endpointPattern));
    const scored = this.endpoints
      .map((e) => ({ ...e, score: pathScore(segments, e.segments) }))
      .filter((e) => e.score >= 0)
      .sort((a, b) => b.score - a.score);

    const sameMethod = scored.filter((e) => e.endpoint.method === call.method);
    if (sameMethod.length > 0) {
      return { ...base, status: "matched", endpointId: sameMethod[0].endpoint.id };
    }
    if (scored.length > 0) {
      const best = scored[0].score;
      return {
        ...base,
        status: "method-mismatch",
        candidates: scored.filter((e) => e.score === best).map((e) => e.endpoint.id),
      };
    }
    const similar = this.endpoints
      .map((e) => ({ id: e.endpoint.id, similarity: similarity(segments, e.segments) }))
      .filter((e) => e.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
      .slice(0, 3)
      .map((e) => e.id);
    return { ...base, status: "not-found", candidates: similar };
  }

  private frontendPath(pattern: string): string {
    const base = this.linking.frontendBasePath ? normalizePath(this.linking.frontendBasePath) : "";
    const path = !base || base === "/" || hasPrefix(pattern, base) ? pattern : joinPath(base, pattern);
    return this.rewrite(path);
  }

  private rewrite(path: string): string {
    const rewrites = Object.entries(this.linking.pathRewrites ?? {})
      .map(([from, to]) => [normalizePath(from), to] as const)
      .sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of rewrites) {
      if (from !== "/" && hasPrefix(path, from)) return normalizePath(`${to}/${path.slice(from.length)}`);
    }
    return path;
  }
}

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * -1 when incompatible. A backend `{param}` accepts any frontend segment; a
 * dynamic frontend segment against a backend literal is compatible but
 * weak, so `/users/${x}` prefers `/users/{id}` over `/users/search`.
 */
function pathScore(frontend: string[], backend: string[]): number {
  if (frontend.length !== backend.length) return -1;
  let score = 0;
  for (let i = 0; i < frontend.length; i++) {
    const fe = frontend[i];
    const be = backend[i];
    if (fe === be) score += 3;
    else if (be === PARAM_PLACEHOLDER) score += 1;
    else if (fe === PARAM_PLACEHOLDER) score += 0;
    else return -1;
  }
  return score;
}

function similarity(frontend: string[], backend: string[]): number {
  let same = 0;
  for (let i = 0; i < Math.min(frontend.length, backend.length); i++) {
    if (frontend[i] === backend[i] && frontend[i] !== PARAM_PLACEHOLDER) same++;
  }
  return same;
}
