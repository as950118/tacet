import type { TacetConfig } from "../config.js";
import type {
  ApiCallInfo,
  BackendManifest,
  DtoInfo,
  EndpointInfo,
  EnumInfo,
  FrontendManifest,
  FunctionInfo,
  PropertyAccessInfo,
} from "../ir/types.js";
import { EndpointLinker, type ApiLink } from "./link.js";

/**
 * In-memory view over a frontend index and (optionally) a backend manifest,
 * with every frontend API call linked to its backend endpoint. All analysis
 * (contract checks, impact queries, graphs) works on this model.
 */
export class ProjectModel {
  readonly apiCalls = new Map<string, ApiCallInfo>();
  readonly functions = new Map<string, FunctionInfo>();
  readonly endpoints = new Map<string, EndpointInfo>();
  readonly dtos = new Map<string, DtoInfo>();
  readonly enums = new Map<string, EnumInfo>();
  readonly links = new Map<string, ApiLink>();
  /** Backend service-to-service requests (Feign / @HttpExchange) linked to the endpoints they call. */
  readonly serviceLinks = new Map<string, ApiLink>();
  private readonly accessesByCall = new Map<string, PropertyAccessInfo[]>();

  constructor(
    readonly frontend: FrontendManifest,
    readonly backend: BackendManifest | null,
    readonly config: TacetConfig = {},
  ) {
    for (const call of frontend.apiCalls) this.apiCalls.set(call.id, call);
    for (const fn of frontend.functions) this.functions.set(fn.id, fn);
    for (const access of frontend.propertyAccesses) {
      const list = this.accessesByCall.get(access.apiCallId) ?? [];
      list.push(access);
      this.accessesByCall.set(access.apiCallId, list);
    }
    for (const endpoint of backend?.endpoints ?? []) this.endpoints.set(endpoint.id, endpoint);
    for (const dto of backend?.dtos ?? []) this.dtos.set(dto.id, dto);
    for (const e of backend?.enums ?? []) this.enums.set(e.id, e);

    if (backend) {
      const linker = new EndpointLinker(backend.endpoints, config.linking);
      for (const call of frontend.apiCalls) this.links.set(call.id, linker.link(call));
      const serviceLinker = new EndpointLinker(backend.endpoints, { backendBasePath: config.linking?.backendBasePath });
      for (const call of backend.serviceCalls ?? []) {
        this.serviceLinks.set(call.id, serviceLinker.linkServiceCall(call, backend.contextPaths));
      }
    }
  }

  get hasBackend(): boolean {
    return this.backend !== null;
  }

  accessesOf(apiCallId: string): PropertyAccessInfo[] {
    return this.accessesByCall.get(apiCallId) ?? [];
  }

  link(apiCallId: string): ApiLink | undefined {
    return this.links.get(apiCallId);
  }

  /**
   * Stable key for "the API a call targets": the backend endpoint id when
   * linked, otherwise what the frontend asked for.
   */
  apiKeyOf(call: ApiCallInfo): string {
    const link = this.links.get(call.id);
    if (link?.endpointId) return link.endpointId;
    if (call.endpointPattern === null) return `${call.method ?? "?"} <${call.calleeExpression}>`;
    return `${call.method ?? "?"} ${call.endpointPattern}`;
  }

  functionName(id: string | null): string | null {
    return id ? this.functions.get(id)?.name ?? null : null;
  }

  componentOf(call: ApiCallInfo): string | null {
    return call.callerFunctionId ? this.functions.get(call.callerFunctionId)?.containingComponent ?? null : null;
  }
}
