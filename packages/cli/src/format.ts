import { groupErrors } from "@tacet-api/core";
import type {
  ApiImpact,
  ChangeReport,
  VerifiedChangeReport,
  VerifiedImpactSite,
  ContractReport,
  FieldImpact,
  FileImpact,
  ImpactSummary,
  SearchHit,
} from "@tacet-api/core";
import type { ExtractBackendResult, IndexFrontendResult } from "./workspace.js";

export function formatIndexResult(r: IndexFrontendResult): string {
  const s = r.summary;
  const lines = [
    `Tacet index written to ${r.indexPath}`,
    `  Files:              ${s.files}`,
    `  Functions:          ${s.functions}`,
    `  API calls:          ${s.apiCalls} (${s.resolvedApiCalls} with resolved endpoint)`,
    `  Property accesses:  ${s.propertyAccesses}`,
    `  Updated files:      ${r.changedFiles.length}`,
  ];
  if (r.scope) {
    lines.push("", `Changed files (${r.scope.length}):`, ...r.scope.map((f) => `  ${f}`));
    lines.push("", `APIs used by the changed files (${r.apis.length}):`);
    for (const api of r.apis) lines.push(`  ${statusMark(api.status)} ${api.apiKey}${api.status === "matched" || api.status === "no-backend" ? "" : `  [${api.status}]`}`);
  }
  return lines.join("\n");
}

export function formatBackendResult(r: ExtractBackendResult, outPath?: string): string {
  const lines = [
    `Tacet backend contract written to ${r.indexPath}${outPath ? ` and ${outPath}` : ""}`,
    `  Endpoints:  ${r.endpoints} (${r.changedEndpoints.length} added, changed or removed)`,
    `  DTOs:       ${r.dtos}`,
    `  Enums:      ${r.enums}`,
    `  Warnings:   ${r.warnings.length}`,
  ];
  for (const w of r.warnings) lines.push(`    - ${w}`);
  return lines.join("\n");
}

export function formatContractReport(report: ContractReport): string {
  const scope = report.scope ? `${report.scope.length} file${report.scope.length === 1 ? "" : "s"}` : "whole frontend";
  const lines = [`Tacet contract check: ${report.result}  (scope: ${scope})`, "", `APIs checked (${report.apis.length}):`];
  const width = Math.max(0, ...report.apis.map((a) => a.apiKey.length));
  for (const api of report.apis) {
    const detail = api.status === "matched"
      ? `${api.callSites} call site${plural(api.callSites)}, ${api.fieldReads} field read${plural(api.fieldReads)}`
      : api.status;
    const issues = api.issues ? `  ${api.issues} issue${plural(api.issues)}` : "";
    lines.push(`  ${api.issues ? "✗" : "✓"} ${api.apiKey.padEnd(width)}  ${detail}${issues}`);
  }
  const c = report.counts;
  lines.push("", `Issues: ${c.error} error${plural(c.error)}, ${c.warning} warning${plural(c.warning)}, ${c.info} info`);
  for (const issue of report.issues) {
    lines.push(
      "",
      `  ${issue.severity.toUpperCase().padEnd(7)} ${issue.file}:${issue.line}:${issue.column}  ${issue.code}`,
      `          ${issue.message}`,
    );
    if (issue.suggestion) lines.push(`          → ${issue.suggestion}`);
    lines.push(`          ${issue.snippet}`);
  }
  return lines.join("\n");
}

export function formatApiImpact(impacts: ApiImpact[], query: string): string {
  if (impacts.length === 0) return `No API matches "${query}".`;
  return impacts
    .map((i) => {
      const lines = [
        `${i.apiKey}  [${i.status}]${i.handler ? `  ${i.handler}` : ""}`,
        `  Affects ${i.files.length} file${plural(i.files.length)}, ${i.components.length} component${plural(i.components.length)}, ${i.callSites.length} call site${plural(i.callSites.length)}, ${i.fieldReads.length} field read${plural(i.fieldReads.length)}`,
      ];
      if (i.callSites.length) {
        lines.push("", "  Call sites:");
        for (const c of i.callSites) {
          lines.push(`    ${c.file}:${c.line}  ${who(c.functionName, c.component)}${c.via ? ` via ${c.via}()` : ""}  ${c.code}`);
        }
      }
      if (i.fields.length) {
        lines.push("", "  Response fields read:");
        for (const f of i.fields) {
          lines.push(`    ${f.path}  (${f.reads})`);
          for (const r of i.fieldReads.filter((r) => r.path === f.path)) {
            lines.push(`      ${r.file}:${r.line}  ${who(r.functionName, r.component)}${r.flow === "derived" ? "  [derived]" : ""}  ${r.code}`);
          }
        }
      }
      if (i.files.length) lines.push("", "  Files:", ...i.files.map((f) => `    ${f}`));
      return lines.join("\n");
    })
    .join("\n\n");
}

export function formatFileImpact(i: FileImpact): string {
  const lines = [
    i.file,
    `  Uses ${i.apis.length} API${plural(i.apis.length)}. Changing it can affect ${i.blastRadius.apis.length} API${plural(i.blastRadius.apis.length)} across ${i.blastRadius.files.length} file${plural(i.blastRadius.files.length)} (${i.blastRadius.components.length} component${plural(i.blastRadius.components.length)}).`,
  ];
  if (i.apis.length) {
    lines.push("", "  APIs used here:");
    for (const api of i.apis) {
      lines.push(`    ${statusMark(api.status)} ${api.apiKey}  (${api.via.join(" + ")})${api.status === "matched" ? "" : `  [${api.status}]`}`);
      for (const f of api.fields) lines.push(`        .${f.path}`);
    }
  }
  if (i.clientFunctions.length) {
    lines.push("", "  API client functions defined here:");
    for (const fn of i.clientFunctions) {
      lines.push(`    ${fn.name}()  → ${fn.apiKeys.join(", ")}  (${fn.callSites.length} caller${plural(fn.callSites.length)})`);
      for (const c of fn.callSites) lines.push(`        ${c.file}:${c.line}  ${who(c.functionName, c.component)}`);
    }
  }
  if (i.dependents.length) lines.push("", `  Imported by (${i.dependents.length}):`, ...i.dependents.map((d) => `    ${d}`));
  lines.push("", "  Blast radius files:", ...i.blastRadius.files.map((f) => `    ${f}`));
  return lines.join("\n");
}

export function formatFieldImpact(impacts: FieldImpact[], query: string): string {
  if (impacts.length === 0) return `No DTO field matches "${query}".`;
  return impacts
    .map((i) => {
      const reads = i.usages.reduce((n, u) => n + u.reads.length, 0);
      const lines = [
        `${i.dtoId}.${i.field}`,
        `  Returned by ${i.usages.length} endpoint path${plural(i.usages.length)}; read ${reads} time${plural(reads)} in ${i.files.length} file${plural(i.files.length)}`,
      ];
      for (const u of i.usages) {
        lines.push("", `  ${u.apiKey}  → ${u.responsePath}`);
        if (u.reads.length === 0) lines.push("    (not read by the frontend)");
        for (const r of u.reads) lines.push(`    ${r.file}:${r.line}  ${who(r.functionName, r.component)}  ${r.code}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function formatSearch(hits: SearchHit[], query: string): string {
  if (hits.length === 0) return `Nothing matches "${query}".`;
  const width = Math.max(...hits.map((h) => h.label.length));
  return [
    `${hits.length} result${plural(hits.length)} for "${query}":`,
    ...hits.map(
      (h) => `  ${h.kind.padEnd(9)} ${h.label.padEnd(width)}  ${h.apis} API${plural(h.apis)}, ${h.files} file${plural(h.files)}${h.detail ? `  ${h.detail}` : ""}`,
    ),
  ].join("\n");
}

export function formatSummary(s: ImpactSummary): string {
  const width = Math.max(0, ...s.apis.map((a) => a.apiKey.length));
  const lines = ["APIs by frontend impact:"];
  for (const a of s.apis) {
    const files = `${a.files} file${plural(a.files)}`.padEnd(9);
    const components = `${a.components} component${plural(a.components)}`.padEnd(13);
    const status = a.status === "matched" ? "" : `[${a.status}]`;
    lines.push(`  ${statusMark(a.status)} ${a.apiKey.padEnd(width)}  ${files}  ${components}  ${status}`.trimEnd());
  }
  lines.push("", "Files by number of APIs used:");
  for (const f of s.files) lines.push(`  ${String(f.apis).padStart(3)}  ${f.file}`);
  if (s.unusedEndpoints.length) {
    lines.push("", `Backend endpoints no frontend code calls (${s.unusedEndpoints.length}):`, ...s.unusedEndpoints.map((e) => `  ${e}`));
  }
  return lines.join("\n");
}

function statusMark(status: string): string {
  if (status === "matched" || status === "no-backend") return "✓";
  if (status === "unused") return "·";
  if (status === "unresolved") return "?";
  return "✗";
}

function who(fn: string | null, component: string | null): string {
  if (component && fn && component !== fn) return `${component} › ${fn}`;
  return component ?? fn ?? "<module>";
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

export function formatChangeReport(report: ChangeReport | VerifiedChangeReport): string {
  const c = report.counts;
  const verified = "ai" in report ? report : null;
  const lines = [
    `Tacet API change report: ${report.result}${verified ? `  (static analysis: ${verified.staticResult})` : ""}`,
    "",
    `Changed APIs: ${c.changedApis}   Breaking changes: ${c.breakingChanges}   Frontend impact: ${c.DEFINITE} definite, ${c.LIKELY} likely, ${c.POSSIBLE} possible`,
  ];
  if (verified) {
    const a = verified.ai;
    lines.push(
      `AI verification (${a.provider}, ${a.model}): ${a.verified}/${a.candidates} checked - ` +
        `${a.counts.FAIL} fail, ${a.counts.WARNING} warning, ${a.counts.PASS} pass, ${a.counts.UNKNOWN} unknown` +
        (a.discarded ? ` (${a.discarded} discarded for missing evidence)` : ""),
    );
    for (const [message, endpoints] of groupErrors(a.errors)) {
      lines.push(`  error (${endpoints.length} API${plural(endpoints.length)}): ${message}`);
    }
  }
  for (const e of report.endpoints) {
    const ai = "ai" in e && e.ai?.result ? `  AI: ${e.ai.result}` : "";
    lines.push("", `${e.endpointId}  [${e.movedTo ? `moved → ${e.movedTo}` : e.status}]  ${e.result}${ai}`);
    for (const ch of e.changes) lines.push(`  ${ch.breaking ? "!" : " "} ${ch.message}`);
    lines.push(
      `  Related files: ${e.relatedFiles.length}   Definite: ${e.counts.DEFINITE}   Likely: ${e.counts.LIKELY}   Possible: ${e.counts.POSSIBLE}`,
    );
    for (const site of e.sites as VerifiedImpactSite[]) {
      lines.push(`    ${site.confidence.padEnd(8)} ${site.file}:${site.line}  ${who(site.functionName, site.component)}  ${site.code}`);
      lines.push(`             ${site.reason}`);
      if (site.ai) {
        lines.push(`             AI ${site.ai.result} (${site.ai.confidence.toFixed(2)}): ${site.ai.reason}`);
        for (const ev of site.ai.evidence) lines.push(`               evidence ${ev.file}:${ev.line}  ${ev.code}`);
      }
    }
  }
  return lines.join("\n");
}

