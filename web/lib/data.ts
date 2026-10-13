import "server-only";
import { unstable_cache } from "next/cache";
import type { PageRow } from "@/components/PagesView";
import type { EndpointRow } from "@/components/UnusedTable";
import { projectPath, tacet, type IndexStatus, type PageApis, type ProjectInfo, type UsageReport } from "./tacet";

/**
 * The dashboard's reads, cached by Vercel. The index only changes when someone re-indexes, so pages render from the
 * cache (and keep rendering while a sleeping API host wakes up); stale entries refresh in the background, and the
 * refresh button drops them at once. Entries hold only what the pages show: Vercel caches up to 2 MB per entry.
 */
const MINUTE = 60;
export const projectTag = (project: string) => `project:${project}`;

export const getProjects = unstable_cache(() => tacet<ProjectInfo[]>("/projects"), ["projects"], {
  revalidate: MINUTE,
  tags: ["projects"],
});

export const getStatus = (project: string) =>
  unstable_cache(() => tacet<IndexStatus>(projectPath(project)), ["status", project], {
    revalidate: 10 * MINUTE,
    tags: [projectTag(project)],
  })();

export interface UsageView {
  totals: UsageReport["totals"];
  unresolvedCalls: number;
  /** The frontends counted: this project's and those of the other projects on the same backend. */
  frontends: string[];
  rows: EndpointRow[];
}

export const getUsage = (project: string) =>
  unstable_cache(
    async (): Promise<UsageView> => {
      const report = await tacet<UsageReport>(projectPath(project, "/unused?all=true"));
      return {
        totals: report.totals,
        unresolvedCalls: report.frontends.reduce((n, f) => n + f.unresolvedCalls, 0),
        frontends: report.frontends.map((f) => f.name),
        rows: report.endpoints.map((e) => ({
          usage: e.usage,
          method: e.method,
          path: e.path,
          controller: e.controller.split(".").pop() ?? e.controller,
          handler: e.handler,
          file: e.location.file,
          line: e.location.line,
          otherMethodsUsed: e.otherMethodsUsed,
          routes: e.routes,
          callers: e.frontends.reduce((n, f) => n + f.calls, 0),
        })),
      };
    },
    ["usage", project],
    { revalidate: 10 * MINUTE, tags: [projectTag(project)] },
  )();

export const getPages = (project: string) =>
  unstable_cache(
    async (): Promise<PageRow[]> =>
      (await tacet<PageApis[]>(projectPath(project, "/pages"))).map((p) => ({
        page: p.page,
        route: p.route,
        component: p.component,
        file: p.file,
        apis: p.apis.map((a) => ({ api: a.apiKey, fields: a.fields.length, common: Boolean(a.common), status: a.status })),
      })),
    ["pages", project],
    { revalidate: 10 * MINUTE, tags: [projectTag(project)] },
  )();
