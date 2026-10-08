package dev.tacet.java;

import com.github.javaparser.ast.Modifier;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.NodeList;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.EnumConstantDeclaration;
import com.github.javaparser.ast.body.EnumDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.nodeTypes.NodeWithAnnotations;
import com.github.javaparser.ast.type.ArrayType;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.ast.type.PrimitiveType;
import com.github.javaparser.ast.type.Type;
import com.github.javaparser.ast.type.TypeParameter;
import com.github.javaparser.ast.type.VoidType;
import com.github.javaparser.ast.type.WildcardType;
import dev.tacet.java.model.Manifest.DtoFieldInfo;
import dev.tacet.java.model.Manifest.DtoInfo;
import dev.tacet.java.model.Manifest.EnumInfo;
import dev.tacet.java.model.Manifest.SourceLocation;
import dev.tacet.java.model.TypeRef;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.UnaryOperator;

/**
 * Maps Java types to the language-agnostic {@link TypeRef} and extracts the JSON shape of every
 * DTO / enum reachable from an endpoint, following Jackson's default serialization rules.
 */
final class TypeModel {
    static final Set<String> SCALARS = Set.of(
            "String", "CharSequence", "Character", "Boolean", "Byte", "Short", "Integer", "Long", "Float",
            "Double", "BigDecimal", "BigInteger", "Number", "UUID", "Date", "LocalDate", "LocalDateTime",
            "LocalTime", "OffsetDateTime", "OffsetTime", "ZonedDateTime", "Instant", "Duration", "Period",
            "YearMonth", "Year", "MonthDay", "URI", "URL", "Currency", "Locale", "ZoneId");
    static final Set<String> COLLECTIONS = Set.of(
            "List", "ArrayList", "LinkedList", "Set", "HashSet", "LinkedHashSet", "TreeSet", "SortedSet",
            "Collection", "Iterable", "Stream", "Queue", "Deque");
    static final Set<String> MAPS = Set.of(
            "Map", "HashMap", "LinkedHashMap", "TreeMap", "SortedMap", "ConcurrentHashMap", "MultiValueMap");
    static final Set<String> TRANSPARENT = Set.of("Optional", "AtomicReference", "JsonNullable");

    private static final Set<String> NOT_NULL = Set.of("NotNull", "NonNull", "Nonnull", "NotBlank", "NotEmpty");
    private static final Set<String> NULLABLE = Set.of("Nullable", "CheckForNull");
    private static final String PAGE_ID = "org.springframework.data.domain.Page";
    private static final String SLICE_ID = "org.springframework.data.domain.Slice";

    /** Type variables in scope, and what they are bound to (when a supertype is parameterized). */
    record Scope(Node context, Map<String, TypeRef> bindings, Set<String> typeParameters) {
        static Scope of(Node context, Set<String> typeParameters) {
            return new Scope(context, Map.of(), typeParameters);
        }
    }

    private final SourceIndex index;
    private final List<String> warnings;
    private final Map<String, DtoInfo> dtos = new TreeMap<>();
    private final Map<String, EnumInfo> enums = new TreeMap<>();
    private final Set<String> seen = new HashSet<>();
    private final Set<String> jsonValueInProgress = new HashSet<>();

    TypeModel(SourceIndex index, List<String> warnings) {
        this.index = index;
        this.warnings = warnings;
    }

    List<DtoInfo> dtos() {
        return List.copyOf(dtos.values());
    }

    List<EnumInfo> enums() {
        return List.copyOf(enums.values());
    }

    Optional<DtoInfo> dto(String id) {
        return Optional.ofNullable(dtos.get(id));
    }

    // ---------------------------------------------------------------------
    // Type mapping
    // ---------------------------------------------------------------------

    TypeRef map(Type type, Scope scope) {
        if (type instanceof PrimitiveType primitive) return TypeRef.scalar(primitive.asString());
        if (type instanceof VoidType) return TypeRef.scalar("void");
        if (type instanceof ArrayType array) {
            Type component = array.getComponentType();
            if (component instanceof PrimitiveType p && p.getType() == PrimitiveType.Primitive.BYTE) {
                return TypeRef.scalar("byte[]");
            }
            return TypeRef.array(map(component, scope));
        }
        if (type instanceof WildcardType wildcard) {
            return wildcard.getExtendedType().map(t -> map(t, scope)).orElse(TypeRef.unknown("?"));
        }
        if (type instanceof ClassOrInterfaceType classType) return mapClass(classType, scope);
        return TypeRef.unknown(type.asString());
    }

    private TypeRef mapClass(ClassOrInterfaceType type, Scope scope) {
        String simple = type.getNameAsString();
        List<Type> args = type.getTypeArguments().map(NodeList::stream).map(s -> s.toList()).orElse(List.of());

        if (type.getScope().isEmpty()) {
            if (scope.bindings().containsKey(simple)) return scope.bindings().get(simple);
            if (scope.typeParameters().contains(simple)) return TypeRef.typeParameter(simple);
        }

        Optional<TypeDeclaration<?>> project = index.resolveType(type.getNameWithScope(), scope.context());
        if (project.isPresent()) {
            TypeDeclaration<?> declaration = project.get();
            if (declaration instanceof EnumDeclaration enumDeclaration) {
                return TypeRef.enumRef(registerEnum(enumDeclaration));
            }
            List<TypeRef> typeArguments = args.stream().map(a -> map(a, scope)).toList();
            Optional<TypeRef> jsonValue = jsonValueType(declaration, typeArguments);
            if (jsonValue.isPresent()) return jsonValue.get();
            return TypeRef.dto(registerDto(declaration), typeArguments);
        }

        if (SCALARS.contains(simple)) return TypeRef.scalar(simple);
        if (COLLECTIONS.contains(simple)) {
            return TypeRef.array(args.isEmpty() ? TypeRef.unknown("Object") : map(args.get(0), scope));
        }
        if (MAPS.contains(simple)) {
            return TypeRef.map(args.size() >= 2 ? map(args.get(1), scope) : TypeRef.unknown("Object"));
        }
        if (TRANSPARENT.contains(simple)) {
            return args.isEmpty() ? TypeRef.unknown(simple) : map(args.get(0), scope);
        }
        if (simple.equals("Page") || simple.equals("Slice")) {
            String id = registerSpringPage(simple.equals("Page"));
            return TypeRef.dto(id, args.stream().map(a -> map(a, scope)).toList());
        }
        return TypeRef.unknown(type.asString());
    }

    /**
     * A class with a {@code @JsonValue} getter or field serializes as that value, e.g.
     * {@code class ResourceData<T> { @JsonValue List<T> getData() }} is a JSON array, not an object.
     */
    private Optional<TypeRef> jsonValueType(TypeDeclaration<?> declaration, List<TypeRef> typeArguments) {
        Optional<Type> valueType = declaration.getMethods().stream()
                .filter(m -> !m.isStatic() && m.getParameters().isEmpty() && Annotations.has(m, "JsonValue"))
                .map(MethodDeclaration::getType)
                .findFirst()
                .or(() -> declaration.getFields().stream()
                        .filter(f -> !f.isStatic() && Annotations.has(f, "JsonValue"))
                        .map(f -> f.getVariable(0).getType())
                        .findFirst());
        String id = SourceIndex.fqn(declaration);
        if (valueType.isEmpty() || !jsonValueInProgress.add(id)) return Optional.empty();
        try {
            List<String> params = typeParameterNames(declaration);
            Map<String, TypeRef> bindings = new HashMap<>();
            for (int i = 0; i < params.size() && i < typeArguments.size(); i++) {
                bindings.put(params.get(i), typeArguments.get(i));
            }
            return Optional.of(map(valueType.get(), new Scope(declaration, bindings, new HashSet<>(params))));
        } finally {
            jsonValueInProgress.remove(id);
        }
    }

    static boolean isOptional(Type type) {
        return type instanceof ClassOrInterfaceType c && TRANSPARENT.contains(c.getNameAsString());
    }

    boolean isNullable(Type type, NodeWithAnnotations<?> annotated) {
        if (type instanceof PrimitiveType) return false;
        if (Annotations.find(annotated, NULLABLE).isPresent() || isOptional(type)) return true;
        return Annotations.find(annotated, NOT_NULL).isEmpty();
    }

    // ---------------------------------------------------------------------
    // DTO extraction
    // ---------------------------------------------------------------------

    private String registerDto(TypeDeclaration<?> declaration) {
        String id = SourceIndex.fqn(declaration);
        if (seen.add(id)) {
            Map<String, DtoFieldInfo> fields = new LinkedHashMap<>();
            collectFields(declaration, Map.of(), UnaryOperator.identity(), fields, new HashSet<>());
            Set<String> ignored = ignoredProperties(declaration);
            List<DtoFieldInfo> visible = fields.values().stream().filter(f -> !ignored.contains(f.name())).toList();
            dtos.put(id, new DtoInfo(
                    id, declaration.getNameAsString(), typeParameterNames(declaration), visible,
                    index.location(declaration)));
        }
        return id;
    }

    /** Collects serialized properties keyed by Java property name; supertypes first so subclasses override. */
    private void collectFields(
            TypeDeclaration<?> type,
            Map<String, TypeRef> bindings,
            UnaryOperator<String> inheritedNaming,
            Map<String, DtoFieldInfo> out,
            Set<String> visited) {
        if (!visited.add(SourceIndex.fqn(type))) return;
        Scope scope = new Scope(type, bindings, new HashSet<>(typeParameterNames(type)));
        UnaryOperator<String> naming = Optional.ofNullable(namingStrategy(type)).orElse(inheritedNaming);

        for (ClassOrInterfaceType supertype : serializedSupertypes(type)) {
            index.resolveType(supertype.getNameWithScope(), type)
                    .filter(t -> !(t instanceof EnumDeclaration))
                    .ifPresent(parent -> {
                        List<String> params = typeParameterNames(parent);
                        List<Type> args = supertype.getTypeArguments().map(l -> (List<Type>) l).orElse(List.of());
                        Map<String, TypeRef> parentBindings = new HashMap<>();
                        for (int i = 0; i < params.size() && i < args.size(); i++) {
                            parentBindings.put(params.get(i), map(args.get(i), scope));
                        }
                        collectFields(parent, parentBindings, naming, out, visited);
                    });
        }

        if (type instanceof RecordDeclaration record) {
            for (Parameter component : record.getParameters()) {
                if (Annotations.has(component, "JsonIgnore")) continue;
                addProperty(out, component.getNameAsString(), component.getType(), component, scope, naming, true);
            }
        }

        for (FieldDeclaration field : type.getFields()) {
            if (field.isStatic() || field.hasModifier(Modifier.Keyword.TRANSIENT)) continue;
            if (Annotations.has(field, "JsonIgnore")) continue;
            for (VariableDeclarator variable : field.getVariables()) {
                addProperty(out, variable.getNameAsString(), variable.getType(), field, scope, naming, true);
            }
        }

        boolean isInterface = type instanceof ClassOrInterfaceDeclaration c && c.isInterface();
        for (MethodDeclaration method : type.getMethods()) {
            Optional<String> property = getterProperty(method, isInterface);
            if (property.isEmpty()) continue;
            if (Annotations.has(method, "JsonIgnore")) {
                out.remove(property.get());
                continue;
            }
            addProperty(out, property.get(), method.getType(), method, scope, naming, false);
        }
    }

    private void addProperty(
            Map<String, DtoFieldInfo> out,
            String javaName,
            Type type,
            NodeWithAnnotations<?> annotated,
            Scope scope,
            UnaryOperator<String> naming,
            boolean override) {
        if (!override && out.containsKey(javaName)) return;
        String jsonName = Annotations.find(annotated, "JsonProperty")
                .flatMap(a -> Annotations.attribute(a, "value"))
                .flatMap(e -> index.resolveString(e, scope.context()))
                .filter(s -> !s.isEmpty())
                .orElseGet(() -> naming.apply(javaName));
        out.put(javaName, new DtoFieldInfo(jsonName, map(type, scope), isNullable(type, annotated)));
    }

    private static List<ClassOrInterfaceType> serializedSupertypes(TypeDeclaration<?> type) {
        return type instanceof ClassOrInterfaceDeclaration c ? c.getExtendedTypes() : List.of();
    }

    /** Jackson bean getter: public, non-static, no parameters, `getX()` or boolean `isX()`. */
    private static Optional<String> getterProperty(MethodDeclaration method, boolean isInterface) {
        if (method.isStatic() || !method.getParameters().isEmpty() || method.getType() instanceof VoidType) {
            return Optional.empty();
        }
        if (!isInterface && !method.isPublic()) return Optional.empty();
        String name = method.getNameAsString();
        String rest;
        if (name.startsWith("get") && name.length() > 3 && Character.isUpperCase(name.charAt(3))) {
            if (name.equals("getClass")) return Optional.empty();
            rest = name.substring(3);
        } else if (name.startsWith("is") && name.length() > 2 && Character.isUpperCase(name.charAt(2))
                && (method.getType().asString().equals("boolean") || method.getType().asString().equals("Boolean"))) {
            rest = name.substring(2);
        } else {
            return Optional.empty();
        }
        return Optional.of(decapitalize(rest));
    }

    /** Jackson's default (non-std bean naming): lowercase the leading upper-case run ("URLPath" -> "urlpath"). */
    static String decapitalize(String name) {
        StringBuilder sb = new StringBuilder(name);
        for (int i = 0; i < sb.length() && Character.isUpperCase(sb.charAt(i)); i++) {
            sb.setCharAt(i, Character.toLowerCase(sb.charAt(i)));
        }
        return sb.toString();
    }

    private static List<String> typeParameterNames(TypeDeclaration<?> type) {
        NodeList<TypeParameter> params = type instanceof ClassOrInterfaceDeclaration c
                ? c.getTypeParameters()
                : type instanceof RecordDeclaration r ? r.getTypeParameters() : new NodeList<>();
        return params.stream().map(TypeParameter::getNameAsString).toList();
    }

    private Set<String> ignoredProperties(TypeDeclaration<?> type) {
        Set<String> ignored = new HashSet<>();
        Annotations.find(type, "JsonIgnoreProperties")
                .flatMap(a -> Annotations.attribute(a, "value"))
                .ifPresent(value -> Annotations.elements(value)
                        .forEach(e -> index.resolveString(e, type).ifPresent(ignored::add)));
        return ignored;
    }

    /** @JsonNaming strategy on the class, or null to inherit. */
    private static UnaryOperator<String> namingStrategy(TypeDeclaration<?> type) {
        Optional<String> strategy = Annotations.find(type, "JsonNaming")
                .flatMap(a -> Annotations.attribute(a, "value"))
                .map(Object::toString);
        if (strategy.isEmpty()) return null;
        String s = strategy.get();
        if (s.contains("SnakeCase")) return n -> separate(n, '_');
        if (s.contains("KebabCase")) return n -> separate(n, '-');
        if (s.contains("LowerDotCase")) return n -> separate(n, '.');
        if (s.contains("UpperCamelCase")) return n -> n.isEmpty() ? n : Character.toUpperCase(n.charAt(0)) + n.substring(1);
        if (s.contains("LowerCase")) return n -> n.toLowerCase();
        return UnaryOperator.identity();
    }

    /** Port of Jackson's SnakeCaseStrategy translation, parameterized by separator. */
    static String separate(String input, char separator) {
        StringBuilder result = new StringBuilder();
        boolean previousTranslated = false;
        for (int i = 0; i < input.length(); i++) {
            char c = input.charAt(i);
            if (i > 0 || c != separator) {
                if (Character.isUpperCase(c)) {
                    if (!previousTranslated && result.length() > 0 && result.charAt(result.length() - 1) != separator) {
                        result.append(separator);
                    }
                    c = Character.toLowerCase(c);
                    previousTranslated = true;
                } else {
                    previousTranslated = false;
                }
                result.append(c);
            }
        }
        return result.toString();
    }

    private String registerEnum(EnumDeclaration declaration) {
        String id = SourceIndex.fqn(declaration);
        if (seen.add(id)) {
            List<String> values = new ArrayList<>();
            for (EnumConstantDeclaration constant : declaration.getEntries()) {
                values.add(Annotations.find(constant, "JsonProperty")
                        .flatMap(a -> Annotations.attribute(a, "value"))
                        .flatMap(e -> index.resolveString(e, declaration))
                        .orElse(constant.getNameAsString()));
            }
            boolean customValue = declaration.getMethods().stream().anyMatch(m -> Annotations.has(m, "JsonValue"));
            if (customValue) {
                warnings.add("Enum " + id + " uses @JsonValue; serialized values may differ from constant names");
            }
            enums.put(id, new EnumInfo(id, declaration.getNameAsString(), values, index.location(declaration)));
        }
        return id;
    }

    /** Spring Data's Page/Slice serialize as objects, not arrays; model their (default) JSON shape. */
    private String registerSpringPage(boolean page) {
        String id = page ? PAGE_ID : SLICE_ID;
        if (seen.add(id)) {
            TypeRef intType = TypeRef.scalar("int");
            TypeRef bool = TypeRef.scalar("boolean");
            List<DtoFieldInfo> fields = new ArrayList<>();
            fields.add(new DtoFieldInfo("content", TypeRef.array(TypeRef.typeParameter("T")), false));
            if (page) {
                fields.add(new DtoFieldInfo("totalElements", TypeRef.scalar("long"), false));
                fields.add(new DtoFieldInfo("totalPages", intType, false));
            }
            for (String name : List.of("number", "size", "numberOfElements")) {
                fields.add(new DtoFieldInfo(name, intType, false));
            }
            for (String name : List.of("first", "last", "empty")) {
                fields.add(new DtoFieldInfo(name, bool, false));
            }
            dtos.put(id, new DtoInfo(
                    id, page ? "Page" : "Slice", List.of("T"), fields, new SourceLocation("<spring-data>", 0, 0)));
        }
        return id;
    }
}
