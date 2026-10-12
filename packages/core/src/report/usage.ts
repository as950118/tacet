import type { EndpointUsage, UsageReport } from "../analysis/usage.js";

const USAGE_LABEL: Record<EndpointUsage["usage"], string> = {
  frontend: "used by a frontend",
  service: "used by a backend service",
  "client-declared": "only a client method nobody calls",
  unused: "unused",
};

/** One row per endpoint (only the unused ones unless `all`): for spreadsheets. */
export function renderUsageCsv(report: UsageReport, options: { all?: boolean } = {}): string {
  const header = [
    "usage", "method", "path", "controller", "handler", "other_methods_used", "routed", "frontend_calls",
    "service_callers", "file", "line",
  ];
  const rows = endpointsOf(report, options.all).map((e) => [
    e.usage,
    e.method,
    e.path,
    simpleName(e.controller),
    e.handler,
    e.otherMethodsUsed.join(" "),
    e.routes === null ? "" : e.routes.length > 0 ? "yes" : "no",
    String(e.frontends.reduce((n, f) => n + f.calls, 0)),
    e.services.map((s) => `${simpleName(s.client)}#${s.handler.split("#")[1]}${s.referenced ? "" : " (never called)"}`).join(" "),
    e.location.file,
    String(e.location.line),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

/** Totals, what the analysis could not see, then the unused endpoints grouped by controller. */
export function renderUsageMarkdown(report: UsageReport): string {
  const t = report.totals;
  const lines: string[] = ["# Endpoint usage", ""];
  lines.push(`Backend \`${report.backendRootDir}\`, frontends: ${report.frontends.map((f) => `**${f.name}**`).join(", ")}.`, "");
  lines.push("| | Endpoints |", "|---|---:|");
  lines.push(`| Used by a frontend | ${t.frontend} |`);
  lines.push(`| Used only by backend services (Feign / @HttpExchange) | ${t.service} |`);
  lines.push(`| Only a client method nobody calls points at it | ${t.clientDeclared} |`);
  lines.push(`| **Unused** | **${t.unused}** |`);
  if (report.gatewayRoutes > 0) lines.push(`| ↳ of which no gateway route reaches | ${t.unusedNotRouted} |`);
  lines.push(`| Total | ${t.endpoints} |`, "");

  lines.push("**Not visible to this analysis** — check these before deleting anything:", "");
  for (const f of report.frontends) {
    if (f.unresolvedCalls > 0) lines.push(`- ${f.name}: ${f.unresolvedCalls} of ${f.apiCalls} API calls have URLs Tacet could not resolve.`);
  }
  lines.push(`- Callers outside the analyzed code: other repositories, batch jobs, external systems, hand-written HTTP calls (RestTemplate / WebClient with built URLs). ${report.serviceCalls} declarative client calls were found.`);
  if (report.gatewayRoutes === 0) lines.push("- No gateway routes were found, so exposure was not checked.");
  lines.push("");

  const unused = report.endpoints.filter((e) => e.usage === "unused" || e.usage === "client-declared");
  const byController = new Map<string, EndpointUsage[]>();
  for (const e of unused) byController.set(e.controller, [...(byController.get(e.controller) ?? []), e]);
  const total = new Map<string, number>();
  for (const e of report.endpoints) total.set(e.controller, (total.get(e.controller) ?? 0) + 1);

  const whole = [...byController].filter(([c, list]) => list.length === total.get(c));
  if (whole.length) {
    lines.push(`## Controllers with no used endpoint (${whole.length})`, "", "| Controller | Endpoints | File |", "|---|---:|---|");
    for (const [c, list] of whole.sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`| ${simpleName(c)} | ${list.length} | \`${list[0].location.file}\` |`);
    }
    lines.push("");
  }

  lines.push(`## Unused endpoints by controller (${unused.length})`, "");
  for (const [c, list] of [...byController].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${simpleName(c)} — ${list.length}/${total.get(c)} unused`, "");
    for (const e of list) {
      const notes = [
        e.usage === "client-declared" ? `client method never called: ${e.services.map((s) => simpleName(s.handler)).join(", ")}` : null,
        e.otherMethodsUsed.length ? `${e.otherMethodsUsed.join("/")} on this path is used` : null,
        e.routes !== null && e.routes.length === 0 ? "no gateway route" : null,
      ].filter(Boolean);
      lines.push(`- \`${e.method} ${e.path}\` ${e.location.file}:${e.location.line}${notes.length ? ` — ${notes.join("; ")}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function describeUsage(usage: EndpointUsage["usage"]): string {
  return USAGE_LABEL[usage];
}

function endpointsOf(report: UsageReport, all = false): EndpointUsage[] {
  return all ? report.endpoints : report.endpoints.filter((e) => e.usage === "unused" || e.usage === "client-declared");
}

function simpleName(qualified: string): string {
  return qualified.split(".").pop() ?? qualified;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
