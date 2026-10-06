import { existsSync, readFileSync } from "node:fs";
import type { HttpMethod } from "./ir/types.js";

export interface ApiClientMapping {
  method: HttpMethod;
  path: string;
}

export interface LinkingConfig {
  /** Prefix the frontend HTTP client adds to every call, e.g. an axios baseURL of "/api". */
  frontendBasePath?: string;
  /** Prefix the backend is served under, e.g. server.servlet.context-path "/api". */
  backendBasePath?: string;
}

export interface TacetConfig {
  /** Explicit mapping from API client calls (e.g. "userApi.getUser") to backend endpoints. */
  apiClientMap?: Record<string, ApiClientMapping>;
  linking?: LinkingConfig;
  /**
   * Explicit pages, for routers Tacet does not recognize: route path → page file, optionally with the
   * component name, e.g. { "/users/:id": "src/pages/User.tsx#UserPage" }. Without a name the file's
   * default export (or its only exported component) is used.
   */
  routes?: Record<string, string>;
}

export function loadConfig(configPath: string | undefined): TacetConfig {
  if (!configPath) return {};
  if (!existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
  return JSON.parse(readFileSync(configPath, "utf8")) as TacetConfig;
}
