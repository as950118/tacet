package dev.tacet.java;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.MethodReferenceExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import dev.tacet.java.model.Manifest.ServiceCallInfo;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Extracts the requests a backend sends to other services through declarative HTTP clients:
 * OpenFeign ({@code @FeignClient} interfaces with Spring MVC mapping annotations) and Spring's
 * {@code @HttpExchange} interfaces. These are the service-to-service callers of endpoints that no
 * frontend calls.
 */
final class ServiceClientExtractor {
    private static final Map<String, String> MVC_SHORTCUTS = Map.of(
            "GetMapping", "GET", "PostMapping", "POST", "PutMapping", "PUT",
            "DeleteMapping", "DELETE", "PatchMapping", "PATCH");
    private static final Map<String, String> EXCHANGE_SHORTCUTS = Map.of(
            "GetExchange", "GET", "PostExchange", "POST", "PutExchange", "PUT",
            "DeleteExchange", "DELETE", "PatchExchange", "PATCH");
    private static final List<String> ALL_METHODS = List.of("GET", "POST", "PUT", "DELETE", "PATCH");

    private final SourceIndex index;
    private final List<String> warnings;

    ServiceClientExtractor(SourceIndex index, List<String> warnings) {
        this.index = index;
        this.warnings = warnings;
    }

    List<ServiceCallInfo> extract() {
        Map<CompilationUnit, Set<String>> calledByUnit = new HashMap<>();
        for (CompilationUnit cu : index.units()) calledByUnit.put(cu, calledNames(cu));

        List<ServiceCallInfo> calls = new ArrayList<>();
        for (CompilationUnit cu : index.units()) {
            for (ClassOrInterfaceDeclaration type : cu.findAll(ClassOrInterfaceDeclaration.class)) {
                if (!type.isInterface()) continue;
                Optional<AnnotationExpr> feign = Annotations.find(type, "FeignClient");
                Optional<AnnotationExpr> exchange = Annotations.find(type, "HttpExchange");
                boolean exchangeMethods = type.getMethods().stream()
                        .anyMatch(m -> Annotations.find(m, exchangeAnnotations()).isPresent());
                if (feign.isEmpty() && exchange.isEmpty() && !exchangeMethods) continue;

                String target = feign.flatMap(a -> Annotations.attribute(a, "url"))
                        .or(() -> feign.flatMap(a -> Annotations.attribute(a, "name", "value")))
                        .map(e -> string(e, type))
                        .orElse(null);
                String prefix = feign.flatMap(a -> Annotations.attribute(a, "path")).map(e -> string(e, type)).orElse("");
                prefix = SpringEndpointExtractor.joinPaths(prefix,
                        Annotations.find(type, "RequestMapping")
                                .or(() -> exchange)
                                .flatMap(a -> Annotations.attribute(a, "value", "path", "url"))
                                .map(e -> string(e, type))
                                .orElse(""));
                String client = SourceIndex.fqn(type);
                for (MethodDeclaration method : type.getMethods()) {
                    boolean referenced = isReferenced(method.getNameAsString(), cu, calledByUnit);
                    calls.addAll(methodCalls(client, target, prefix, method, referenced));
                }
            }
        }
        calls.sort(Comparator.comparing(ServiceCallInfo::client).thenComparing(ServiceCallInfo::path)
                .thenComparing(ServiceCallInfo::method));
        return calls;
    }

    private List<ServiceCallInfo> methodCalls(
            String client, String target, String prefix, MethodDeclaration method, boolean referenced) {
        Set<String> names = new HashSet<>(MVC_SHORTCUTS.keySet());
        names.addAll(exchangeAnnotations());
        names.add("RequestMapping");
        Optional<AnnotationExpr> mapping = Annotations.find(method, names);
        if (mapping.isEmpty()) return List.of();

        AnnotationExpr annotation = mapping.get();
        String simple = Annotations.simpleName(annotation.getNameAsString());
        String shortcut = MVC_SHORTCUTS.getOrDefault(simple, EXCHANGE_SHORTCUTS.get(simple));
        List<String> methods = shortcut != null ? List.of(shortcut) : requestMethods(annotation);
        List<Expression> paths = Annotations.attribute(annotation, "value", "path", "url")
                .map(Annotations::elements)
                .orElse(List.of());
        List<String> resolved = paths.isEmpty() ? List.of("") : paths.stream().map(e -> string(e, method)).toList();

        String handler = client + "#" + method.getNameAsString();
        List<ServiceCallInfo> calls = new ArrayList<>();
        for (String path : resolved) {
            String fullPath = SpringEndpointExtractor.joinPaths(prefix, path);
            for (String httpMethod : methods) {
                calls.add(new ServiceCallInfo(
                        handler + " " + httpMethod + " " + fullPath, client, target, httpMethod, fullPath, handler,
                        referenced, index.location(method.getName())));
            }
        }
        return calls;
    }

    /** {@code method = RequestMethod.GET} (Feign) or {@code method = "GET"} (@HttpExchange); any method when absent. */
    private static List<String> requestMethods(AnnotationExpr annotation) {
        Optional<Expression> value = Annotations.attribute(annotation, "method");
        if (value.isEmpty()) return ALL_METHODS;
        List<String> methods = new ArrayList<>();
        for (Expression e : Annotations.elements(value.get())) {
            String name = e instanceof FieldAccessExpr f ? f.getNameAsString()
                    : e instanceof NameExpr n ? n.getNameAsString()
                    : e instanceof StringLiteralExpr s ? s.getValue().toUpperCase()
                    : e.toString();
            if (ALL_METHODS.contains(name)) methods.add(name);
        }
        return methods.isEmpty() ? ALL_METHODS : methods;
    }

    private String string(Expression expression, Node context) {
        Optional<String> resolved = index.resolveString(expression, context);
        if (resolved.isEmpty()) {
            warnings.add("Could not resolve client path expression `" + expression + "` at "
                    + index.location(expression).file() + ":" + index.location(expression).line());
        }
        return resolved.orElse("<" + expression + ">");
    }

    private static Set<String> exchangeAnnotations() {
        Set<String> names = new HashSet<>(EXCHANGE_SHORTCUTS.keySet());
        names.add("HttpExchange");
        return names;
    }

    /**
     * Whether code outside the client's own file calls a method of this name. Name-based (no type resolution),
     * so it can only say a client method is certainly never called, which is what unused-API reports need.
     */
    private static boolean isReferenced(String name, CompilationUnit own, Map<CompilationUnit, Set<String>> calledByUnit) {
        for (Map.Entry<CompilationUnit, Set<String>> entry : calledByUnit.entrySet()) {
            if (entry.getKey() != own && entry.getValue().contains(name)) return true;
        }
        return false;
    }

    private static Set<String> calledNames(CompilationUnit cu) {
        Set<String> names = new HashSet<>();
        cu.findAll(MethodCallExpr.class).forEach(call -> names.add(call.getNameAsString()));
        cu.findAll(MethodReferenceExpr.class).forEach(ref -> names.add(ref.getIdentifier()));
        return names;
    }
}
