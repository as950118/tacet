package dev.tacet.java;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.BodyDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.EnumDeclaration;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.BinaryExpr;
import com.github.javaparser.ast.expr.EnclosedExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import dev.tacet.java.model.Manifest.SourceLocation;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Parsed backend sources plus source-level name resolution (imports, same package, nested
 * types, static imports, compile-time string constants). Resolution works on source alone, so
 * the extractor does not need the backend's dependency classpath (Spring, Lombok, ...) in CI.
 */
final class SourceIndex {
    private static final Set<String> EXCLUDED_DIRS =
            Set.of("build", "target", "out", ".gradle", ".git", ".idea", "node_modules");
    private static final int MAX_CONSTANT_DEPTH = 16;

    private final Path root;
    private final List<CompilationUnit> units = new ArrayList<>();
    private final Map<String, TypeDeclaration<?>> typesByFqn = new HashMap<>();

    private SourceIndex(Path root) {
        this.root = root;
    }

    static SourceIndex load(Path root, List<String> warnings) throws IOException {
        SourceIndex index = new SourceIndex(root);
        JavaParser parser = new JavaParser(
                new ParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21));
        List<Path> files;
        try (Stream<Path> paths = Files.walk(root)) {
            files = paths.filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> !index.isExcluded(p))
                    .sorted()
                    .toList();
        }
        for (Path file : files) {
            ParseResult<CompilationUnit> result = parser.parse(file);
            if (result.isSuccessful() && result.getResult().isPresent()) {
                index.register(result.getResult().get());
            } else {
                String problem = result.getProblems().isEmpty()
                        ? "unknown error"
                        : result.getProblems().get(0).getMessage().split("\n")[0];
                warnings.add("Failed to parse " + index.relative(file) + ": " + problem);
            }
        }
        return index;
    }

    List<CompilationUnit> units() {
        return units;
    }

    Path root() {
        return root;
    }

    boolean isExcluded(Path file) {
        String rel = relative(file);
        if (rel.contains("src/test/")) return true;
        for (Path segment : root.relativize(file)) {
            if (EXCLUDED_DIRS.contains(segment.toString())) return true;
        }
        return false;
    }

    private void register(CompilationUnit cu) {
        units.add(cu);
        for (TypeDeclaration<?> type : cu.getTypes()) registerType(type);
    }

    private void registerType(TypeDeclaration<?> type) {
        type.getFullyQualifiedName().ifPresent(fqn -> typesByFqn.put(fqn, type));
        for (BodyDeclaration<?> member : type.getMembers()) {
            if (member instanceof TypeDeclaration<?> inner) registerType(inner);
        }
    }

    String relative(Path file) {
        return root.relativize(file).toString().replace('\\', '/');
    }

    SourceLocation location(Node node) {
        String file = node.findCompilationUnit()
                .flatMap(CompilationUnit::getStorage)
                .map(s -> relative(s.getPath()))
                .orElse("<unknown>");
        return node.getBegin()
                .map(p -> new SourceLocation(file, p.line, p.column))
                .orElse(new SourceLocation(file, 0, 0));
    }

    static String fqn(TypeDeclaration<?> type) {
        return type.getFullyQualifiedName().orElse(type.getNameAsString());
    }

    // ---------------------------------------------------------------------
    // Type resolution
    // ---------------------------------------------------------------------

    /** Resolves a (possibly qualified) type name as seen from `context` to a project type, if any. */
    Optional<TypeDeclaration<?>> resolveType(String name, Node context) {
        int dot = name.indexOf('.');
        if (dot >= 0) {
            TypeDeclaration<?> direct = typesByFqn.get(name);
            if (direct != null) return Optional.of(direct);
            String rest = name.substring(dot);
            return resolveType(name.substring(0, dot), context)
                    .map(outer -> typesByFqn.get(fqn(outer) + rest));
        }

        for (Node n = context; n != null; n = n.getParentNode().orElse(null)) {
            if (n instanceof TypeDeclaration<?> type) {
                if (type.getNameAsString().equals(name)) return Optional.of(type);
                for (BodyDeclaration<?> member : type.getMembers()) {
                    if (member instanceof TypeDeclaration<?> inner && inner.getNameAsString().equals(name)) {
                        return Optional.of(inner);
                    }
                }
            }
        }

        CompilationUnit cu = context.findCompilationUnit().orElse(null);
        if (cu == null) return Optional.empty();
        for (ImportDeclaration imp : cu.getImports()) {
            if (imp.isStatic() || imp.isAsterisk()) continue;
            String imported = imp.getNameAsString();
            // An explicit import of an external type wins over same-package lookup.
            if (imported.endsWith("." + name)) return Optional.ofNullable(typesByFqn.get(imported));
        }
        String pkg = cu.getPackageDeclaration().map(p -> p.getNameAsString() + ".").orElse("");
        TypeDeclaration<?> samePackage = typesByFqn.get(pkg + name);
        if (samePackage != null) return Optional.of(samePackage);
        for (ImportDeclaration imp : cu.getImports()) {
            if (imp.isStatic() || !imp.isAsterisk()) continue;
            TypeDeclaration<?> type = typesByFqn.get(imp.getNameAsString() + "." + name);
            if (type != null) return Optional.of(type);
        }
        return Optional.empty();
    }

    // ---------------------------------------------------------------------
    // Compile-time string constants (e.g. @RequestMapping(ApiPaths.USERS))
    // ---------------------------------------------------------------------

    Optional<String> resolveString(Expression expression, Node context) {
        return resolveString(expression, context, 0);
    }

    private Optional<String> resolveString(Expression e, Node context, int depth) {
        if (depth > MAX_CONSTANT_DEPTH) return Optional.empty();
        if (e instanceof StringLiteralExpr literal) return Optional.of(literal.asString());
        if (e instanceof EnclosedExpr enclosed) return resolveString(enclosed.getInner(), context, depth + 1);
        if (e instanceof BinaryExpr binary && binary.getOperator() == BinaryExpr.Operator.PLUS) {
            Optional<String> left = resolveString(binary.getLeft(), context, depth + 1);
            Optional<String> right = resolveString(binary.getRight(), context, depth + 1);
            return left.isPresent() && right.isPresent() ? Optional.of(left.get() + right.get()) : Optional.empty();
        }
        if (e instanceof NameExpr name) return resolveConstant(name.getNameAsString(), context, depth);
        if (e instanceof FieldAccessExpr field) {
            return resolveType(field.getScope().toString(), context)
                    .flatMap(type -> constantIn(type, field.getNameAsString(), depth, new HashSet<>()));
        }
        return Optional.empty();
    }

    private Optional<String> resolveConstant(String name, Node context, int depth) {
        for (Node n = context; n != null; n = n.getParentNode().orElse(null)) {
            if (n instanceof TypeDeclaration<?> type) {
                Optional<String> value = constantIn(type, name, depth, new HashSet<>());
                if (value.isPresent()) return value;
            }
        }
        CompilationUnit cu = context.findCompilationUnit().orElse(null);
        if (cu == null) return Optional.empty();
        for (ImportDeclaration imp : cu.getImports()) {
            if (!imp.isStatic()) continue;
            String imported = imp.getNameAsString();
            String owner;
            if (imp.isAsterisk()) {
                owner = imported;
            } else if (imported.endsWith("." + name)) {
                owner = imported.substring(0, imported.length() - name.length() - 1);
            } else {
                continue;
            }
            TypeDeclaration<?> type = typesByFqn.get(owner);
            if (type == null) continue;
            Optional<String> value = constantIn(type, name, depth, new HashSet<>());
            if (value.isPresent()) return value;
        }
        return Optional.empty();
    }

    private Optional<String> constantIn(TypeDeclaration<?> type, String name, int depth, Set<String> visited) {
        if (!visited.add(fqn(type))) return Optional.empty();
        Optional<VariableDeclarator> variable = type.getFieldByName(name)
                .flatMap(f -> f.getVariables().stream().filter(v -> v.getNameAsString().equals(name)).findFirst());
        if (variable.isPresent() && variable.get().getInitializer().isPresent()) {
            return resolveString(variable.get().getInitializer().get(), variable.get(), depth + 1);
        }
        for (ClassOrInterfaceType supertype : supertypes(type)) {
            Optional<String> value = resolveType(supertype.getNameWithScope(), type)
                    .flatMap(t -> constantIn(t, name, depth, visited));
            if (value.isPresent()) return value;
        }
        return Optional.empty();
    }

    static List<ClassOrInterfaceType> supertypes(TypeDeclaration<?> type) {
        List<ClassOrInterfaceType> result = new ArrayList<>();
        if (type instanceof ClassOrInterfaceDeclaration c) {
            result.addAll(c.getExtendedTypes());
            result.addAll(c.getImplementedTypes());
        } else if (type instanceof EnumDeclaration e) {
            result.addAll(e.getImplementedTypes());
        } else if (type instanceof RecordDeclaration r) {
            result.addAll(r.getImplementedTypes());
        }
        return result;
    }
}
