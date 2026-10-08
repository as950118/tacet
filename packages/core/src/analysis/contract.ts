import type { ApiCallInfo, EndpointInfo, PropertyAccessInfo } from "../ir/types.js";
import { formatAccessPath } from "../path.js";
import type { LinkStatus } from "./link.js";
import type { ProjectModel } from "./model.js";
import { checkPath, describeType } from "./type-path.js";

export type Severity = "error" | "warning" | "info";

export type IssueCode =
  | "ENDPOINT_NOT_FOUND"
  | "METHOD_MISMATCH"
  | "UNRESOLVED_ENDPOINT"
  | "NO_RESPONSE_BODY"
  | "FIELD_NOT_FOUND"
  | "NOT_AN_ARRAY"
  | "NOT_AN_OBJECT"
  | "UNVERIFIABLE_FIELD"
  | "FALLBACK_FIELD_NOT_FOUND"
  | "UNKNOWN_BODY_FIELD"
  | "MISSING_BODY_FIELD"
  | "UNKNOWN_QUERY_PARAM"
  | "MISSING_QUERY_PARAM";

export interface ContractIssue {
  severity: Severity;
  code: IssueCode;
  message: string;
  suggestion: string | null;
  file: string;
  line: number;
  column: number;
  snippet: string;
  apiKey: string;
  apiCallId: string;
  accessId: string | null;
}

export interface CheckedApi {
  apiKey: string;
  status: LinkStatus;
  endpointId: string | null;
  handler: string | null;
  callSites: number;
  fieldReads: number;
  issues: number;
}

export type ContractResult = "PASS" | "WARNING" | "FAIL";

export interface ContractReport {
  result: ContractResult;
  /** Files the check was limited to, or null for the whole frontend. */
  scope: string[] | null;
  apis: CheckedApi[];
  issues: ContractIssue[];
  counts: Record<Severity, number>;
}

export interface ContractCheckOptions {
  /** Limit to APIs used by these frontend files (calls in them, or response fields read in them). */
  files?: string[];
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Verifies frontend API usage against the backend contract: the endpoint
 * exists for that method, request keys are accepted, and every response
 * field the frontend reads exists in the response type.
 */
export function checkContract(model: ProjectModel, options: ContractCheckOptions = {}): ContractReport {
  if (!model.hasBackend) {
    throw new Error("The index has no backend manifest. Run `tacet extract-backend <dir> --index <db>` first.");
  }
  const scope = options.files ? new Set(options.files) : null;
  const { calls, accesses } = selectScope(model, scope);
  const issues: ContractIssue[] = [];
  const matchedFallbacks = matchedFallbackGroups(calls, accesses, model);
  const apis = new Map<string, CheckedApi>();

  for (const call of calls) {
    const link = model.link(call.id)!;
    const apiKey = model.apiKeyOf(call);
    const endpoint = link.endpointId ? model.endpoints.get(link.endpointId)! : null;
    const api = apis.get(apiKey) ?? {
      apiKey,
      status: link.status,
      endpointId: link.endpointId,
      handler: endpoint?.handler ?? null,
      callSites: 0,
      fieldReads: 0,
      issues: 0,
    };
    apis.set(apiKey, api);
    api.callSites++;

    const issue = (severity: Severity, code: IssueCode, message: string, suggestion: string | null = null) =>
      issues.push({
        severity, code, message, suggestion,
        file: call.file, line: call.location.line, column: call.location.column, snippet: call.code,
        apiKey, apiCallId: call.id, accessId: null,
      });

    if (link.status === "unresolved") {
      issue("info", "UNRESOLVED_ENDPOINT", `The URL of \`${call.calleeExpression}\` cannot be determined statically`,
        "Add the client to `apiClientMap` in tacet.config.json");
    } else if (link.status === "not-found") {
      issue("error", "ENDPOINT_NOT_FOUND", `Backend has no endpoint for ${call.method} ${call.endpointPattern}`,
        link.candidates.length ? `Similar endpoints: ${link.candidates.join(", ")}` : null);
    } else if (link.status === "method-mismatch") {
      issue("error", "METHOD_MISMATCH", `Backend does not accept ${call.method} on ${call.endpointPattern}`,
        `Available: ${link.candidates.join(", ")}`);
    } else if (endpoint) {
      checkRequest(call, endpoint, model, issue);
    }

    for (const access of accesses.get(call.id) ?? []) {
      api.fieldReads++;
      if (endpoint) checkAccess(access, call, endpoint, apiKey, model, issues, matchedFallbacks);
    }
  }

  for (const api of apis.values()) {
    api.issues = issues.filter((i) => i.apiKey === api.apiKey).length;
  }
  issues.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column,
  );
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  return {
    result: counts.error > 0 ? "FAIL" : counts.warning > 0 ? "WARNING" : "PASS",
    scope: options.files ? [...options.files].sort() : null,
    apis: [...apis.values()].sort((a, b) => a.apiKey.localeCompare(b.apiKey)),
    issues,
    counts,
  };
}

/**
 * Calls located in the scope files, plus calls whose response is read there
 * (e.g. a child component reading a prop). Accesses: every read of those
 * calls, wherever it is, since changing the call can break any of them.
 */
function selectScope(model: ProjectModel, scope: Set<string> | null) {
  const calls = new Map<string, ApiCallInfo>();
  for (const call of model.apiCalls.values()) {
    if (!scope || scope.has(call.file)) calls.set(call.id, call);
  }
  if (scope) {
    for (const access of model.frontend.propertyAccesses) {
      const call = model.apiCalls.get(access.apiCallId);
      if (call && scope.has(access.file)) calls.set(call.id, call);
    }
  }
  const accesses = new Map<string, PropertyAccessInfo[]>();
  for (const call of calls.values()) {
    const reads = model
      .accessesOf(call.id)
      .filter((a) => !scope || scope.has(a.file) || scope.has(call.file));
    accesses.set(call.id, reads);
  }
  const ordered = [...calls.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.location.line - b.location.line,
  );
  return { calls: ordered, accesses };
}

function checkRequest(
  call: ApiCallInfo,
  endpoint: EndpointInfo,
  model: ProjectModel,
  issue: (severity: Severity, code: IssueCode, message: string, suggestion?: string | null) => void,
): void {
  const { queryKeys, bodyKeys } = call.request;

  if (queryKeys !== null) {
    const accepted = endpoint.requestParams.filter((p) => p.source === "query");
    for (const key of queryKeys) {
      if (!accepted.some((p) => p.name === key)) {
        issue("warning", "UNKNOWN_QUERY_PARAM", `${endpoint.id} does not accept query parameter \`${key}\``,
          suggest(key, accepted.map((p) => p.name)));
      }
    }
    for (const param of accepted.filter((p) => p.required && !queryKeys.includes(p.name))) {
      issue("warning", "MISSING_QUERY_PARAM", `${endpoint.id} requires query parameter \`${param.name}\``);
    }
  }

  if (bodyKeys !== null) {
    const bodyType = endpoint.requestBody?.type;
    const dto = bodyType?.kind === "dto" ? model.dtos.get(bodyType.dtoId) : undefined;
    if (!endpoint.requestBody && bodyKeys.length > 0) {
      issue("warning", "UNKNOWN_BODY_FIELD", `${endpoint.id} does not take a request body`);
    } else if (dto) {
      const fields = dto.fields.map((f) => f.name);
      for (const key of bodyKeys.filter((k) => !fields.includes(k))) {
        issue("warning", "UNKNOWN_BODY_FIELD", `${dto.name} has no field \`${key}\``, suggest(key, fields));
      }
      if (endpoint.requestBody?.required) {
        for (const field of dto.fields.filter((f) => !f.nullable && !bodyKeys.includes(f.name))) {
          issue("warning", "MISSING_BODY_FIELD", `${dto.name}.${field.name} is required but not sent`);
        }
      }
    }
  }
}

/** `??` / `||` chains in which at least one read matches the response. */
function matchedFallbackGroups(
  calls: ApiCallInfo[],
  accesses: Map<string, PropertyAccessInfo[]>,
  model: ProjectModel,
): Set<string> {
  const matched = new Set<string>();
  for (const call of calls) {
    const endpointId = model.link(call.id)?.endpointId;
    const response = endpointId ? model.endpoints.get(endpointId)?.response : null;
    if (!response) continue;
    for (const access of accesses.get(call.id) ?? []) {
      if (access.fallbackGroup && checkPath(response, access.path, model).status === "ok") {
        matched.add(access.fallbackGroup);
      }
    }
  }
  return matched;
}

function checkAccess(
  access: PropertyAccessInfo,
  call: ApiCallInfo,
  endpoint: EndpointInfo,
  apiKey: string,
  model: ProjectModel,
  issues: ContractIssue[],
  matchedFallbacks: Set<string>,
): void {
  const push = (severity: Severity, code: IssueCode, message: string, suggestion: string | null = null) =>
    issues.push({
      severity, code, message, suggestion,
      file: access.file, line: access.location.line, column: access.location.column, snippet: access.code,
      apiKey, apiCallId: call.id, accessId: access.id,
    });
  const shown = formatAccessPath(access.path);
  const derived = access.flow === "derived";
  const via = derived ? " (value passed through a function Tacet could not follow)" : "";

  if (endpoint.response === null) {
    push(derived ? "warning" : "error", "NO_RESPONSE_BODY", `Reads \`${shown}\` but ${endpoint.id} returns no body${via}`);
    return;
  }
  const result = checkPath(endpoint.response, access.path, model);
  if (result.status === "ok") return;
  if (result.status === "unverifiable") {
    push("info", "UNVERIFIABLE_FIELD", `Cannot verify \`${shown}\`: type \`${result.typeName}\` is not known`);
    return;
  }
  const segment = access.path[result.at];
  if (access.fallbackGroup && matchedFallbacks.has(access.fallbackGroup)) {
    push("info", "FALLBACK_FIELD_NOT_FOUND",
      `\`${shown}\` does not exist in ${endpoint.id}, but another alternative of this fallback chain does`);
    return;
  }
  const severity = derived ? "warning" : "error";
  if (result.reason === "no-such-field") {
    push(severity, "FIELD_NOT_FOUND",
      `${result.parentType} has no field \`${segment}\` (reading \`${shown}\` from ${endpoint.id})${via}`,
      suggest(segment, result.available));
  } else if (result.reason === "not-an-array") {
    push(severity, "NOT_AN_ARRAY",
      `Treats ${result.parentType} as an array (reading \`${shown}\` from ${endpoint.id})${via}`,
      `Response type is ${describeType(endpoint.response, model)}`);
  } else {
    push(severity, "NOT_AN_OBJECT",
      `Reads \`${segment}\` on ${result.parentType}, which has no properties (reading \`${shown}\`)${via}`);
  }
}

function suggest(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1;
  for (const candidate of candidates) {
    const d = distance(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best ? `Did you mean \`${best}\`?` : null;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = temp;
    }
  }
  return row[b.length];
}
