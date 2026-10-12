package dev.tacet.java.model;

import java.util.List;

/** Output records mirroring the Backend IR in packages/core/src/ir/types.ts. */
public final class Manifest {
    private Manifest() {}

    public record SourceLocation(String file, int line, int column) {}

    public record ParamInfo(String name, TypeRef type, boolean required, String source) {}

    public record DtoFieldInfo(String name, TypeRef type, boolean nullable) {}

    public record DtoInfo(
            String id, String name, List<String> typeParameters, List<DtoFieldInfo> fields, SourceLocation location) {}

    public record EnumInfo(String id, String name, List<String> values, SourceLocation location) {}

    public record RequestBody(TypeRef type, boolean required) {}

    public record EndpointInfo(
            String id,
            String method,
            String path,
            String handler,
            List<ParamInfo> requestParams,
            RequestBody requestBody,
            TypeRef response,
            SourceLocation location) {}

    /** A request this backend sends to another service through a declarative client (@FeignClient, @HttpExchange). */
    public record ServiceCallInfo(
            String id,
            String client,
            String target,
            String method,
            String path,
            String handler,
            boolean referenced,
            SourceLocation location) {}

    public record PathRewrite(String regex, String replacement) {}

    /** A Spring Cloud Gateway route: requests matching `paths` are forwarded to `uri` after the filters rewrite them. */
    public record GatewayRouteInfo(
            String id,
            String uri,
            List<String> paths,
            List<PathRewrite> rewrites,
            int stripPrefix,
            String prefixPath,
            SourceLocation location) {}

    public record BackendManifest(
            String language,
            String rootDir,
            String generatedAt,
            List<EndpointInfo> endpoints,
            List<DtoInfo> dtos,
            List<EnumInfo> enums,
            List<ServiceCallInfo> serviceCalls,
            List<GatewayRouteInfo> gatewayRoutes,
            List<String> contextPaths,
            List<String> warnings) {}
}
