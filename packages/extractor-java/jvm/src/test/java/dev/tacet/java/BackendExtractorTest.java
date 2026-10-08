package dev.tacet.java;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.tacet.java.model.Manifest.BackendManifest;
import dev.tacet.java.model.Manifest.DtoFieldInfo;
import dev.tacet.java.model.Manifest.DtoInfo;
import dev.tacet.java.model.Manifest.EndpointInfo;
import dev.tacet.java.model.Manifest.ParamInfo;
import dev.tacet.java.model.TypeRef;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BackendExtractorTest {
    private static final String USER_RESPONSE = "com.example.user.UserResponse";
    private static BackendManifest manifest;

    @BeforeAll
    static void extractFixture() throws IOException {
        Path fixtures = Path.of(System.getProperty("tacet.fixtures"));
        manifest = new BackendExtractor().extract(fixtures.resolve("backend"));
    }

    private static EndpointInfo endpoint(String id) {
        return manifest.endpoints().stream().filter(e -> e.id().equals(id)).findFirst()
                .orElseThrow(() -> new AssertionError("missing endpoint " + id));
    }

    private static DtoInfo dto(String id) {
        return manifest.dtos().stream().filter(d -> d.id().equals(id)).findFirst()
                .orElseThrow(() -> new AssertionError("missing dto " + id));
    }

    private static TypeRef dtoRef(String id, TypeRef... args) {
        return TypeRef.dto(id, List.of(args));
    }

    @Nested
    class Endpoints {
        @Test
        void findsEveryHandlerAndSkipsClientsViewsAndTestSources() {
            assertEquals(
                    List.of(
                            "DELETE /admin/users/{id}/sessions",
                            "GET /products/{id}",
                            "GET /users",
                            "POST /users",
                            "GET /users/search",
                            "GET /users/summary",
                            "DELETE /users/{id}",
                            "GET /users/{id}",
                            "PUT /users/{id}",
                            "PATCH /users/{id}/status"),
                    manifest.endpoints().stream().map(EndpointInfo::id).toList());
            assertEquals(List.of(), manifest.warnings());
        }

        @Test
        void combinesClassPrefixWithConstantPaths() {
            EndpointInfo getUser = endpoint("GET /users/{id}");
            assertEquals("/users/{id}", getUser.path());
            assertEquals("com.example.user.UserController#getUser", getUser.handler());
            assertEquals("src/main/java/com/example/user/UserController.java", getUser.location().file());
            assertEquals(17, getUser.location().line());
            assertEquals(dtoRef(USER_RESPONSE), getUser.response());
        }

        @Test
        void resolvesStaticImportedConstantsInExpressions() {
            assertEquals("/admin/users/{id}/sessions", endpoint("DELETE /admin/users/{id}/sessions").path());
        }

        @Test
        void extractsPathQueryAndHeaderParameters() {
            assertEquals(
                    List.of(new ParamInfo("id", TypeRef.scalar("Long"), true, "path")),
                    endpoint("PUT /users/{id}").requestParams());
            assertEquals(
                    List.of(
                            new ParamInfo("name", TypeRef.scalar("String"), false, "query"),
                            new ParamInfo("page", TypeRef.scalar("int"), false, "query")),
                    endpoint("GET /users").requestParams());
            assertEquals(
                    new ParamInfo("X-Actor", TypeRef.scalar("String"), true, "header"),
                    endpoint("PATCH /users/{id}/status").requestParams().get(1));
        }

        @Test
        void expandsModelAttributeObjectsAndPageable() {
            assertEquals(
                    List.of("keyword", "minAge", "status", "page", "size", "sort"),
                    endpoint("GET /users/search").requestParams().stream().map(ParamInfo::name).toList());
        }

        @Test
        void unwrapsResponseWrappersAndCollections() {
            EndpointInfo create = endpoint("POST /users");
            assertEquals(dtoRef(USER_RESPONSE), create.response());
            assertEquals(dtoRef("com.example.user.CreateUserRequest"), create.requestBody().type());
            assertTrue(create.requestBody().required());

            assertEquals(TypeRef.array(dtoRef(USER_RESPONSE)), endpoint("GET /users").response());
            assertEquals(
                    dtoRef("com.example.common.ApiResponse", dtoRef(USER_RESPONSE)),
                    endpoint("PUT /users/{id}").response());
            assertEquals(
                    dtoRef("org.springframework.data.domain.Page", dtoRef(USER_RESPONSE)),
                    endpoint("GET /users/search").response());
            assertEquals(TypeRef.enumRef("com.example.user.UserStatus"), endpoint("PATCH /users/{id}/status").response());
        }

        @Test
        void treatsVoidResponsesAsNoBody() {
            assertNull(endpoint("DELETE /users/{id}").response());
            assertNull(endpoint("DELETE /admin/users/{id}/sessions").response());
        }
    }

    @Nested
    class Dtos {
        @Test
        void flattensInheritedFieldsAndAppliesJacksonAnnotations() {
            assertEquals(
                    List.of(
                            new DtoFieldInfo("updatedAt", TypeRef.scalar("Instant"), true),
                            new DtoFieldInfo("id", TypeRef.scalar("Long"), true),
                            new DtoFieldInfo("name", TypeRef.scalar("String"), true),
                            new DtoFieldInfo("age", TypeRef.scalar("int"), false),
                            new DtoFieldInfo("profile", dtoRef(USER_RESPONSE + ".Profile"), true),
                            new DtoFieldInfo("status", TypeRef.enumRef("com.example.user.UserStatus"), true),
                            new DtoFieldInfo("tags", TypeRef.array(TypeRef.scalar("String")), true),
                            new DtoFieldInfo("created_at", TypeRef.scalar("LocalDateTime"), true)),
                    dto(USER_RESPONSE).fields());
        }

        @Test
        void resolvesNestedTypesAndNullabilityAnnotations() {
            assertEquals(
                    List.of(
                            new DtoFieldInfo("email", TypeRef.scalar("String"), false),
                            new DtoFieldInfo("phone", TypeRef.scalar("String"), true)),
                    dto(USER_RESPONSE + ".Profile").fields());
        }

        @Test
        void supportsRecordsAndGenerics() {
            DtoInfo apiResponse = dto("com.example.common.ApiResponse");
            assertEquals(List.of("T"), apiResponse.typeParameters());
            assertEquals(new DtoFieldInfo("data", TypeRef.typeParameter("T"), true), apiResponse.fields().get(1));

            DtoInfo product = dto("com.example.product.ProductResponse");
            assertEquals(new DtoFieldInfo("id", TypeRef.scalar("long"), false), product.fields().get(0));
            assertEquals(TypeRef.map(TypeRef.scalar("String")), product.fields().get(2).type());
        }

        @Test
        void appliesNamingStrategyAndGetterOnlyProperties() {
            assertEquals(
                    List.of("display_name", "age", "full_label"),
                    dto("com.example.user.UpdateUserRequest").fields().stream().map(DtoFieldInfo::name).toList());
            assertEquals(
                    List.of("id", "name", "active"),
                    dto("com.example.user.UserSummary").fields().stream().map(DtoFieldInfo::name).toList());
        }

        @Test
        void extractsEnumValuesWithJsonPropertyOverrides() {
            assertEquals(List.of("ACTIVE", "INACTIVE", "banned"), manifest.enums().get(0).values());
        }

        @Test
        void onlyIncludesTypesReachableFromEndpoints() {
            assertFalse(manifest.dtos().stream().anyMatch(d -> d.id().equals("com.example.common.BaseResponse")));
        }
    }

    @Nested
    class EdgeCases {
        @TempDir
        Path dir;

        private BackendManifest extract(Map<String, String> files) throws IOException {
            for (Map.Entry<String, String> file : files.entrySet()) {
                Path path = dir.resolve(file.getKey());
                Files.createDirectories(path.getParent());
                Files.writeString(path, file.getValue());
            }
            return new BackendExtractor().extract(dir);
        }

        @Test
        void reportsUnparsableFilesAndKeepsGoing() throws IOException {
            BackendManifest result = extract(Map.of(
                    "src/Broken.java", "public class Broken {",
                    "src/Ok.java", """
                            @RestController
                            public class Ok {
                                @GetMapping("/ok") public String ok() { return "ok"; }
                            }
                            """));
            assertEquals(List.of("GET /ok"), result.endpoints().stream().map(EndpointInfo::id).toList());
            assertEquals(1, result.warnings().size());
            assertTrue(result.warnings().get(0).startsWith("Failed to parse src/Broken.java"));
        }

        @Test
        void warnsAboutUnresolvablePathConstants() throws IOException {
            BackendManifest result = extract(Map.of("src/A.java", """
                    import external.Paths;
                    @RestController
                    public class A {
                        @GetMapping(Paths.USERS) public String a() { return ""; }
                    }
                    """));
            assertEquals("/<Paths.USERS>", result.endpoints().get(0).path());
            assertTrue(result.warnings().get(0).contains("Paths.USERS"));
        }

        @Test
        void sameHandlerMappedToEquivalentPathsIsNotADuplicate() throws IOException {
            BackendManifest result = extract(Map.of("src/A.java", """
                    @RestController
                    @RequestMapping("/items")
                    public class A {
                        @GetMapping({"", "/"}) public String list() { return ""; }
                    }
                    """));
            assertEquals(List.of("GET /items"), result.endpoints().stream().map(EndpointInfo::id).toList());
            assertEquals(List.of(), result.warnings());
        }

        @Test
        void requestMappingWithoutMethodMatchesEveryMethod() throws IOException {
            BackendManifest result = extract(Map.of("src/A.java", """
                    @RestController
                    public class A {
                        @RequestMapping("/any") public String a() { return ""; }
                        @RequestMapping(path = "/two", method = {RequestMethod.GET, RequestMethod.POST})
                        public String b() { return ""; }
                    }
                    """));
            assertEquals(
                    List.of("DELETE /any", "GET /any", "PATCH /any", "POST /any", "PUT /any", "GET /two", "POST /two"),
                    result.endpoints().stream().map(EndpointInfo::id).toList());
        }

        @Test
        void handlesSelfReferencingDtos() throws IOException {
            BackendManifest result = extract(Map.of("src/A.java", """
                    import java.util.List;
                    @RestController
                    public class A {
                        @GetMapping("/tree") public Node tree() { return null; }
                        public static class Node { private String name; private List<Node> children; }
                    }
                    """));
            assertEquals(
                    List.of(
                            new DtoFieldInfo("name", TypeRef.scalar("String"), true),
                            new DtoFieldInfo("children", TypeRef.array(TypeRef.dto("A.Node", List.of())), true)),
                    result.dtos().get(0).fields());
        }

        @Test
        void classWithJsonValueSerializesAsThatValue() throws IOException {
            BackendManifest result = extract(Map.of("src/A.java", """
                    import java.util.List;
                    @RestController
                    public class A {
                        @GetMapping("/items") public Envelope<ResourceData<Item>> items() { return null; }
                        public static class Envelope<T> { private T data; }
                        public static class ResourceData<T> {
                            private List<T> data;
                            @JsonValue public List<T> getData() { return data; }
                        }
                        public static class Code { @JsonValue private String value; }
                        public static class Item { private String sku; private Code code; }
                    }
                    """));
            EndpointInfo items = result.endpoints().get(0);
            assertEquals(TypeRef.dto("A.Envelope", List.of(TypeRef.array(TypeRef.dto("A.Item", List.of())))), items.response());
            DtoInfo item = result.dtos().stream().filter(d -> d.id().equals("A.Item")).findFirst().orElseThrow();
            assertEquals(TypeRef.scalar("String"), item.fields().get(1).type());
            assertTrue(result.dtos().stream().noneMatch(d -> d.id().equals("A.ResourceData")));
        }

        @Test
        void substitutesTypeArgumentsOfGenericSuperclasses() throws IOException {
            BackendManifest result = extract(Map.of("src/A.java", """
                    import java.util.List;
                    @RestController
                    public class A {
                        @GetMapping("/items") public ItemPage items() { return null; }
                        public static class PageResponse<T> { private List<T> items; private long total; }
                        public static class Item { private String sku; }
                        public static class ItemPage extends PageResponse<Item> {}
                    }
                    """));
            DtoInfo page = result.dtos().stream().filter(d -> d.id().equals("A.ItemPage")).findFirst().orElseThrow();
            assertEquals(TypeRef.array(TypeRef.dto("A.Item", List.of())), page.fields().get(0).type());
        }

        @Test
        void serializesTypeRefsWithKindDiscriminator() throws IOException {
            BackendManifest result = extract(Map.of("src/A.java", """
                    @RestController
                    public class A { @GetMapping("/a") public java.util.List<String> a() { return null; } }
                    """));
            String json = Main.toJson(result);
            assertTrue(json.contains("\"response\":{\"kind\":\"array\",\"element\":{\"kind\":\"scalar\",\"name\":\"String\"}}"), json);
        }
    }
}
