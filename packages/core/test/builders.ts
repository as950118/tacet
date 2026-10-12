import type {
  ApiCallInfo,
  BackendManifest,
  DtoInfo,
  EndpointInfo,
  FrontendManifest,
  FunctionInfo,
  HttpMethod,
  PropertyAccessInfo,
  ServiceCallInfo,
  TypeRef,
} from "../src/ir/types.js";

const loc = (file: string, line = 1) => ({ file, line, column: 1 });

export const t = {
  scalar: (name: string): TypeRef => ({ kind: "scalar", name }),
  dto: (dtoId: string, ...typeArguments: TypeRef[]): TypeRef => ({ kind: "dto", dtoId, typeArguments }),
  array: (element: TypeRef): TypeRef => ({ kind: "array", element }),
  map: (value: TypeRef): TypeRef => ({ kind: "map", value }),
  enumRef: (enumId: string): TypeRef => ({ kind: "enum", enumId }),
  param: (name: string): TypeRef => ({ kind: "typeParameter", name }),
  unknown: (name: string): TypeRef => ({ kind: "unknown", name }),
};

export function dto(id: string, fields: Record<string, TypeRef | [TypeRef, boolean]>, typeParameters: string[] = []): DtoInfo {
  return {
    id,
    name: id.split(".").pop()!,
    typeParameters,
    fields: Object.entries(fields).map(([name, f]) =>
      Array.isArray(f) ? { name, type: f[0], nullable: f[1] } : { name, type: f, nullable: true },
    ),
    location: loc("Dto.java"),
  };
}

export function endpoint(
  method: HttpMethod,
  path: string,
  response: TypeRef | null,
  extra: Partial<EndpointInfo> = {},
): EndpointInfo {
  return {
    id: `${method} ${path}`,
    method,
    path,
    handler: `Controller#${method.toLowerCase()}`,
    requestParams: [],
    requestBody: null,
    response,
    location: loc("Controller.java"),
    ...extra,
  };
}

export function backend(endpoints: EndpointInfo[], dtos: DtoInfo[] = []): BackendManifest {
  return {
    language: "java",
    rootDir: "/backend",
    generatedAt: "2026-01-01T00:00:00Z",
    endpoints,
    dtos,
    enums: [{ id: "Status", name: "Status", values: ["A"], location: loc("Status.java") }],
    serviceCalls: [],
    gatewayRoutes: [],
    contextPaths: [],
    warnings: [],
  };
}

export function serviceCall(
  method: HttpMethod,
  path: string,
  extra: Partial<ServiceCallInfo> = {},
): ServiceCallInfo {
  const handler = extra.handler ?? `com.example.UserClient#${method.toLowerCase()}`;
  return {
    id: `${handler} ${method} ${path}`,
    client: handler.split("#")[0],
    target: "${services.user.url}",
    method,
    path,
    handler,
    referenced: true,
    location: loc("UserClient.java"),
    ...extra,
  };
}

export function fn(id: string, file: string, component: string | null = null): FunctionInfo {
  return {
    id,
    name: id,
    file,
    params: [],
    returnType: null,
    calls: [],
    location: loc(file),
    containingComponent: component,
  };
}

export function call(
  id: string,
  method: HttpMethod | null,
  pattern: string | null,
  extra: Partial<ApiCallInfo> = {},
): ApiCallInfo {
  const file = extra.file ?? "src/a.ts";
  return {
    id,
    endpointPattern: pattern,
    method,
    calleeExpression: "axios.get",
    resolution: "direct",
    wrapperFunctionId: null,
    callerFunctionId: null,
    file,
    location: loc(file, 10),
    arguments: [],
    request: { queryKeys: null, bodyKeys: null },
    returnVarType: null,
    code: `call ${id}`,
    ...extra,
  };
}

export function access(
  id: string,
  apiCallId: string,
  path: string[],
  extra: Partial<PropertyAccessInfo> = {},
): PropertyAccessInfo {
  const file = extra.file ?? "src/a.ts";
  return {
    id,
    apiCallId,
    object: "x",
    path,
    flow: "direct",
    file,
    location: loc(file, 20),
    containingFunctionId: null,
    containingComponent: null,
    code: `x.${path.join(".")}`,
    ...extra,
  };
}

export function frontend(
  apiCalls: ApiCallInfo[],
  propertyAccesses: PropertyAccessInfo[] = [],
  functions: FunctionInfo[] = [],
  files?: FrontendManifest["files"],
): FrontendManifest {
  const paths = new Set([...apiCalls.map((c) => c.file), ...propertyAccesses.map((a) => a.file), ...functions.map((f) => f.file)]);
  return {
    language: "typescript",
    rootDir: "/frontend",
    generatedAt: "2026-01-01T00:00:00Z",
    files: files ?? [...paths].map((path) => ({ path, imports: [], exports: [] })),
    functions,
    apiCalls,
    propertyAccesses,
  };
}
