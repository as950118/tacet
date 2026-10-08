package dev.tacet.java;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.ast.type.Type;
import com.github.javaparser.ast.type.TypeParameter;
import com.github.javaparser.ast.type.VoidType;
import com.github.javaparser.ast.type.WildcardType;
import dev.tacet.java.model.Manifest.EndpointInfo;
import dev.tacet.java.model.Manifest.ParamInfo;
import dev.tacet.java.model.Manifest.RequestBody;
import dev.tacet.java.model.TypeRef;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/** Extracts Spring MVC endpoints (@RequestMapping and its shortcuts) from controller sources. */
final class SpringEndpointExtractor {
    private static final Map<String, String> SHORTCUTS = Map.of(
            "GetMapping", "GET", "PostMapping", "POST", "PutMapping", "PUT",
            "DeleteMapping", "DELETE", "PatchMapping", "PATCH");
    private static final List<String> ALL_METHODS = List.of("GET", "POST", "PUT", "DELETE", "PATCH");
    private static final Set<String> MAPPING_ANNOTATIONS;

    static {
        Set<String> names = new HashSet<>(SHORTCUTS.keySet());
        names.add("RequestMapping");
        MAPPING_ANNOTATIONS = Set.copyOf(names);
    }

    /** Declarative HTTP clients use the same annotations but are not endpoints of this backend. */
    private static final Set<String> CLIENT_ANNOTATIONS = Set.of("FeignClient", "HttpExchange");
    /** Return types whose body is their first type argument. */
    private static final Set<String> RESPONSE_WRAPPERS = Set.of(
            "ResponseEntity", "HttpEntity", "Optional", "CompletableFuture", "CompletionStage", "Future",
            "ListenableFuture", "Callable", "DeferredResult", "WebAsyncTask", "Mono");
    /** Handler parameters Spring injects itself; they are not part of the HTTP contract. */
    private static final Set<String> FRAMEWORK_TYPES = Set.of(
            "HttpServletRequest", "HttpServletResponse", "ServletRequest", "ServletResponse", "HttpSession",
            "Principal", "Authentication", "Model", "ModelMap", "BindingResult", "Errors",
            "Locale", "TimeZone", "ZoneId", "WebRequest", "NativeWebRequest", "ServerWebExchange",
            "ServerHttpRequest", "ServerHttpResponse", "UriComponentsBuilder", "RedirectAttributes",
            "SessionStatus", "HttpMethod", "HttpHeaders", "InputStream", "OutputStream", "Reader", "Writer");
    /** Annotations that do not change how a parameter binds. */
    private static final Set<String> PASSIVE_ANNOTATIONS = Set.of(
            "Valid", "Validated", "NotNull", "NotBlank", "NotEmpty", "Nullable", "NonNull", "Min", "Max",
            "Size", "Pattern", "Positive", "PositiveOrZero", "Negative", "Email", "Parameter", "Schema",
            "ApiParam", "ModelAttribute", "ParameterObject", "Final");

    private final SourceIndex index;
    private final TypeModel types;
    private final List<String> warnings;

    SpringEndpointExtractor(SourceIndex index, TypeModel types, List<String> warnings) {
        this.index = index;
        this.types = types;
        this.warnings = warnings;
    }

    List<EndpointInfo> extract() {
        Map<String, EndpointInfo> endpoints = new LinkedHashMap<>();
        for (CompilationUnit cu : index.units()) {
            for (ClassOrInterfaceDeclaration type : cu.findAll(ClassOrInterfaceDeclaration.class)) {
                if (!isEndpointContainer(type)) continue;
                List<String> prefixes = Annotations.find(type, "RequestMapping")
                        .map(a -> paths(a, type))
                        .orElse(List.of(""));
                boolean bodyByDefault = type.isInterface()
                        || Annotations.has(type, "RestController", "ResponseBody");
                for (MethodDeclaration method : type.getMethods()) {
                    extractMethod(type, method, prefixes, bodyByDefault).forEach(endpoint -> {
                        EndpointInfo previous = endpoints.putIfAbsent(endpoint.id(), endpoint);
                        // @GetMapping({"", "/"}) maps one handler to the same normalized path twice.
                        if (previous != null && !previous.handler().equals(endpoint.handler())) {
                            warnings.add("Duplicate endpoint " + endpoint.id() + " in " + previous.handler()
                                    + " and " + endpoint.handler());
                        }
                    });
                }
            }
        }
        return endpoints.values().stream()
                .sorted(Comparator.comparing(EndpointInfo::path).thenComparing(EndpointInfo::method))
                .toList();
    }

    private static boolean isEndpointContainer(ClassOrInterfaceDeclaration type) {
        if (Annotations.has(type, CLIENT_ANNOTATIONS.toArray(String[]::new))) return false;
        return Annotations.has(type, "RestController", "Controller", "RequestMapping") || type.isInterface();
    }

    private List<EndpointInfo> extractMethod(
            ClassOrInterfaceDeclaration type, MethodDeclaration method, List<String> prefixes, boolean bodyByDefault) {
        Optional<AnnotationExpr> mapping = Annotations.find(method, MAPPING_ANNOTATIONS);
        if (mapping.isEmpty()) return List.of();
        // @Controller methods without @ResponseBody render views, not JSON.
        if (!bodyByDefault && !Annotations.has(method, "ResponseBody") && !returns(method, "ResponseEntity", "HttpEntity")) {
            return List.of();
        }

        AnnotationExpr annotation = mapping.get();
        String shortcut = SHORTCUTS.get(Annotations.simpleName(annotation.getNameAsString()));
        List<String> httpMethods = shortcut != null ? List.of(shortcut) : requestMethods(annotation);
        String handler = SourceIndex.fqn(type) + "#" + method.getNameAsString();

        Set<String> typeParameters = new HashSet<>();
        type.getTypeParameters().forEach(p -> typeParameters.add(p.getNameAsString()));
        method.getTypeParameters().stream().map(TypeParameter::getNameAsString).forEach(typeParameters::add);
        TypeModel.Scope scope = TypeModel.Scope.of(method, typeParameters);

        List<ParamInfo> params = new ArrayList<>();
        RequestBody body = null;
        for (Parameter parameter : method.getParameters()) {
            Optional<AnnotationExpr> requestBody = Annotations.find(parameter, "RequestBody");
            if (requestBody.isPresent()) {
                boolean required = Annotations.booleanAttribute(requestBody.get(), "required").orElse(true);
                body = new RequestBody(types.map(parameter.getType(), scope), required);
            } else {
                params.addAll(parameters(parameter, scope, handler));
            }
        }
        TypeRef response = response(method.getType(), scope);

        List<EndpointInfo> result = new ArrayList<>();
        for (String prefix : prefixes) {
            for (String path : paths(annotation, method)) {
                String fullPath = joinPaths(prefix, path);
                for (String httpMethod : httpMethods) {
                    result.add(new EndpointInfo(
                            httpMethod + " " + fullPath, httpMethod, fullPath, handler, List.copyOf(params), body,
                            response, index.location(method.getName())));
                }
            }
        }
        return result;
    }

    private List<ParamInfo> parameters(Parameter parameter, TypeModel.Scope scope, String handler) {
        Type type = parameter.getType();
        for (String[] binding : new String[][] {
                {"PathVariable", "path"}, {"RequestParam", "query"}, {"RequestHeader", "header"}}) {
            Optional<AnnotationExpr> annotation = Annotations.find(parameter, binding[0]);
            if (annotation.isEmpty()) continue;
            Optional<String> explicitName = Annotations.attribute(annotation.get(), "value", "name")
                    .flatMap(e -> index.resolveString(e, parameter));
            // @RequestParam Map<String, String> binds every parameter; nothing specific to track.
            if (explicitName.isEmpty() && isMap(type)) return List.of();
            boolean required = Annotations.booleanAttribute(annotation.get(), "required").orElse(true)
                    && Annotations.attribute(annotation.get(), "defaultValue").isEmpty()
                    && !TypeModel.isOptional(type);
            return List.of(new ParamInfo(
                    explicitName.orElse(parameter.getNameAsString()), types.map(type, scope), required, binding[1]));
        }

        boolean hasBindingAnnotation = parameter.getAnnotations().stream()
                .map(a -> Annotations.simpleName(a.getNameAsString()))
                .anyMatch(name -> !PASSIVE_ANNOTATIONS.contains(name));
        if (hasBindingAnnotation) return List.of();
        if (type instanceof ClassOrInterfaceType c) {
            // Spring Data binds these from ?page=&size=&sort=
            if (c.getNameAsString().equals("Pageable")) {
                return List.of(
                        new ParamInfo("page", TypeRef.scalar("int"), false, "query"),
                        new ParamInfo("size", TypeRef.scalar("int"), false, "query"),
                        new ParamInfo("sort", TypeRef.scalar("String"), false, "query"));
            }
            if (c.getNameAsString().equals("Sort")) {
                return List.of(new ParamInfo("sort", TypeRef.scalar("String"), false, "query"));
            }
            if (FRAMEWORK_TYPES.contains(c.getNameAsString())) return List.of();
        }

        // No annotation: simple types bind as optional query params, objects bind each property (@ModelAttribute).
        TypeRef ref = types.map(type, scope);
        if (ref instanceof TypeRef.Scalar || ref instanceof TypeRef.EnumRef || ref instanceof TypeRef.ArrayOf) {
            return List.of(new ParamInfo(parameter.getNameAsString(), ref, false, "query"));
        }
        if (ref instanceof TypeRef.Dto dto) {
            return types.dto(dto.dtoId())
                    .map(info -> info.fields().stream()
                            .map(f -> new ParamInfo(f.name(), f.type(), false, "query"))
                            .toList())
                    .orElse(List.of());
        }
        warnings.add("Skipped parameter '" + parameter.getNameAsString() + "' of " + handler
                + ": cannot determine how " + type.asString() + " binds");
        return List.of();
    }

    private TypeRef response(Type type, TypeModel.Scope scope) {
        if (type instanceof VoidType) return null;
        if (type instanceof ClassOrInterfaceType c) {
            String name = c.getNameAsString();
            if (name.equals("Void")) return null;
            List<Type> args = c.getTypeArguments().map(l -> (List<Type>) l).orElse(List.of());
            if (RESPONSE_WRAPPERS.contains(name)) {
                if (args.isEmpty() || (args.get(0) instanceof WildcardType w && w.getExtendedType().isEmpty())) {
                    return TypeRef.unknown(c.asString());
                }
                return response(args.get(0), scope);
            }
            if (name.equals("Flux") && !args.isEmpty()) return TypeRef.array(types.map(args.get(0), scope));
        }
        return types.map(type, scope);
    }

    private List<String> paths(AnnotationExpr annotation, Node context) {
        Optional<Expression> value = Annotations.attribute(annotation, "value", "path");
        if (value.isEmpty()) return List.of("");
        List<String> paths = new ArrayList<>();
        for (Expression expression : Annotations.elements(value.get())) {
            Optional<String> resolved = index.resolveString(expression, context);
            if (resolved.isEmpty()) {
                warnings.add("Could not resolve path expression `" + expression + "` at "
                        + index.location(expression).file() + ":" + index.location(expression).line());
            }
            paths.add(resolved.orElse("<" + expression + ">"));
        }
        return paths;
    }

    private static List<String> requestMethods(AnnotationExpr annotation) {
        Optional<Expression> value = Annotations.attribute(annotation, "method");
        if (value.isEmpty()) return ALL_METHODS;
        List<String> methods = Annotations.elements(value.get()).stream()
                .map(e -> e instanceof FieldAccessExpr f ? f.getNameAsString()
                        : e instanceof NameExpr n ? n.getNameAsString() : e.toString())
                .filter(ALL_METHODS::contains)
                .collect(Collectors.toCollection(ArrayList::new));
        return methods.isEmpty() ? ALL_METHODS : methods;
    }

    static String joinPaths(String prefix, String path) {
        String joined = ("/" + prefix + "/" + path).replaceAll("/{2,}", "/");
        return joined.length() > 1 && joined.endsWith("/") ? joined.substring(0, joined.length() - 1) : joined;
    }

    private static boolean returns(MethodDeclaration method, String... names) {
        return method.getType() instanceof ClassOrInterfaceType c && List.of(names).contains(c.getNameAsString());
    }

    private static boolean isMap(Type type) {
        return type instanceof ClassOrInterfaceType c && TypeModel.MAPS.contains(c.getNameAsString());
    }
}
