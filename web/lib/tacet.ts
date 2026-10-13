import "server-only";

/** The Tacet API, called from the server only: the token never reaches the browser. */
export function apiConfig() {
  const url = process.env.TACET_API_URL;
  if (!url) throw new Error("TACET_API_URL is not set");
  return { url: url.replace(/\/+$/, ""), token: process.env.TACET_API_TOKEN };
}

export class TacetApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function tacetFetch(path: string): Promise<Response> {
  const { url, token } = apiConfig();
  return fetch(`${url}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: "no-store",
  });
}

export async function tacet<T>(path: string): Promise<T> {
  const res = await tacetFetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new TacetApiError(res.status, (body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const projectPath = (project: string, rest = "") => `/projects/${encodeURIComponent(project)}${rest}`;

export interface ProjectInfo {
  name: string;
  frontend: { rootDir: string; generatedAt: string } | null;
  backend: { rootDir: string; generatedAt: string } | null;
}

export interface IndexStatus {
  project: string;
  frontend: { rootDir: string; generatedAt: string } | null;
  backend: { rootDir: string; generatedAt: string } | null;
  summary: Record<string, number>;
}

export interface EndpointUsage {
  endpoint: string;
  method: string;
  path: string;
  handler: string;
  controller: string;
  location: { file: string; line: number };
  usage: "frontend" | "service" | "client-declared" | "unused";
  frontends: Array<{ frontend: string; calls: number; files: string[] }>;
  services: unknown[];
  otherMethodsUsed: string[];
  routes: string[] | null;
}

export interface UsageReport {
  frontends: Array<{ name: string; apiCalls: number; unresolvedCalls: number }>;
  totals: { endpoints: number; frontend: number; service: number; clientDeclared: number; unused: number; unusedNotRouted: number };
  endpoints: EndpointUsage[];
}

export interface PageApis {
  page: string;
  route: string | null;
  component: string;
  file: string;
  apis: Array<{ apiKey: string; status?: string; fields: string[]; common?: boolean }>;
}
