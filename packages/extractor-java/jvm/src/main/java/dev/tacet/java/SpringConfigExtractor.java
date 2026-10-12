package dev.tacet.java;

import dev.tacet.java.model.Manifest.GatewayRouteInfo;
import dev.tacet.java.model.Manifest.PathRewrite;
import dev.tacet.java.model.Manifest.SourceLocation;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Reads the parts of Spring configuration (application.yml / .properties and imported YAML files) that decide
 * how requests reach endpoints: servlet context paths, and Spring Cloud Gateway routes declared in configuration.
 * A small line-based reader rather than a YAML library: it only needs keys, scalars and simple lists.
 */
final class SpringConfigExtractor {
    private static final Pattern YAML_KEY = Pattern.compile("^(\\s*)([^\\s#:][^:#]*?):(?:\\s+(.*))?$");
    private static final Pattern LIST_ITEM = Pattern.compile("^(\\s*)-\\s*(.*)$");
    private static final Pattern SHORTCUT = Pattern.compile("^(Path|RewritePath|StripPrefix|PrefixPath)\\s*=\\s*(.+)$");
    private static final Pattern INLINE_KEY = Pattern.compile("^([A-Za-z_][\\w-]*):\\s*(.*)$");
    private static final Pattern PROPERTY_ROUTE = Pattern.compile(
            "^.*\\.routes\\[(\\d+)]\\.(id|uri|predicates\\[\\d+]|filters\\[\\d+])\\s*[=:]\\s*(.*)$");

    private final SourceIndex index;
    private final List<String> warnings;
    private final List<GatewayRouteInfo> routes = new ArrayList<>();
    private final TreeSet<String> contextPaths = new TreeSet<>();

    SpringConfigExtractor(SourceIndex index, List<String> warnings) {
        this.index = index;
        this.warnings = warnings;
    }

    void extract() throws IOException {
        List<Path> files;
        try (Stream<Path> paths = Files.walk(index.root())) {
            files = paths.filter(Files::isRegularFile)
                    .filter(p -> {
                        String name = p.getFileName().toString();
                        return name.endsWith(".yml") || name.endsWith(".yaml") || name.endsWith(".properties");
                    })
                    .filter(p -> p.toString().replace('\\', '/').contains("/resources/"))
                    .filter(p -> !index.isExcluded(p))
                    .sorted()
                    .toList();
        }
        for (Path file : files) {
            List<String> lines;
            try {
                lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            } catch (IOException e) {
                warnings.add("Could not read " + index.relative(file) + ": " + e.getMessage());
                continue;
            }
            if (file.getFileName().toString().endsWith(".properties")) readProperties(index.relative(file), lines);
            else readYaml(index.relative(file), lines);
        }
    }

    List<GatewayRouteInfo> routes() {
        return List.copyOf(routes);
    }

    List<String> contextPaths() {
        return List.copyOf(contextPaths);
    }

    private void readYaml(String file, List<String> lines) {
        Deque<int[]> indents = new ArrayDeque<>();
        Deque<String> keys = new ArrayDeque<>();
        RouteBuilder route = null;
        int routesIndent = -1;
        int itemIndent = -1;
        String argsOf = null;

        for (int i = 0; i < lines.size(); i++) {
            String raw = stripComment(lines.get(i));
            if (raw.isBlank()) continue;
            if (raw.startsWith("---")) {
                indents.clear();
                keys.clear();
                route = finish(route);
                routesIndent = -1;
                continue;
            }
            int indent = raw.length() - raw.stripLeading().length();

            if (routesIndent >= 0) {
                if (indent <= routesIndent && !raw.stripLeading().startsWith("-")) {
                    route = finish(route);
                    routesIndent = -1;
                } else {
                    Matcher item = LIST_ITEM.matcher(raw);
                    String content = raw.strip();
                    if (item.matches()) {
                        if (itemIndent < 0) itemIndent = indent;
                        content = item.group(2).strip();
                        if (indent == itemIndent) {
                            route = finish(route);
                            route = new RouteBuilder(new SourceLocation(file, i + 1, indent + 1));
                            argsOf = null;
                        } else {
                            argsOf = null;
                        }
                    }
                    if (route != null) argsOf = routeLine(route, content, argsOf);
                    continue;
                }
            }

            Matcher key = YAML_KEY.matcher(raw);
            if (!key.matches() || raw.stripLeading().startsWith("-")) continue;
            while (!indents.isEmpty() && indents.peek()[0] >= indent) {
                indents.pop();
                keys.pop();
            }
            String name = key.group(2).strip();
            String value = key.group(3) == null ? "" : unquote(key.group(3).strip());
            indents.push(new int[] {indent});
            keys.push(name);
            String path = String.join(".", reversed(keys));
            if (path.endsWith("servlet.context-path") || path.endsWith("servlet.contextPath")
                    || path.equals("spring.webflux.base-path")) {
                addContextPath(value);
            }
            if (value.isEmpty() && name.equals("routes") && path.contains("gateway")) {
                routesIndent = indent;
                itemIndent = -1;
            }
        }
        finish(route);
    }

    /** Applies one line inside a route item; returns the predicate/filter name whose `args:` follow. */
    private String routeLine(RouteBuilder route, String content, String argsOf) {
        Matcher shortcut = SHORTCUT.matcher(content);
        if (shortcut.matches()) {
            route.apply(shortcut.group(1), unquote(shortcut.group(2).strip()));
            return null;
        }
        Matcher pair = INLINE_KEY.matcher(content);
        if (!pair.matches()) return argsOf;
        String key = pair.group(1);
        String value = unquote(pair.group(2).strip());
        switch (key) {
            case "id" -> route.id = value;
            case "uri" -> route.uri = value;
            case "name" -> {
                return value;
            }
            case "args", "predicates", "filters" -> {
                return argsOf;
            }
            default -> route.applyArg(argsOf, key, value);
        }
        return argsOf;
    }

    private void readProperties(String file, List<String> lines) {
        Map<Integer, RouteBuilder> byIndex = new TreeMap<>();
        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i).strip();
            if (line.isEmpty() || line.startsWith("#") || line.startsWith("!")) continue;
            if (line.matches("^server\\.servlet\\.context-?[pP]ath\\s*[=:].*")
                    || line.matches("^spring\\.webflux\\.base-path\\s*[=:].*")) {
                addContextPath(line.split("[=:]", 2)[1].strip());
                continue;
            }
            Matcher m = PROPERTY_ROUTE.matcher(line);
            if (!m.matches() || !line.contains("gateway")) continue;
            int at = i + 1;
            RouteBuilder route = byIndex.computeIfAbsent(Integer.parseInt(m.group(1)),
                    k -> new RouteBuilder(new SourceLocation(file, at, 1)));
            String value = m.group(3).strip();
            switch (m.group(2)) {
                case "id" -> route.id = value;
                case "uri" -> route.uri = value;
                default -> {
                    Matcher shortcut = SHORTCUT.matcher(value);
                    if (shortcut.matches()) route.apply(shortcut.group(1), shortcut.group(2).strip());
                }
            }
        }
        byIndex.values().forEach(this::finish);
    }

    private RouteBuilder finish(RouteBuilder route) {
        if (route != null && !route.paths.isEmpty()) routes.add(route.build());
        return null;
    }

    private void addContextPath(String value) {
        String path = placeholderDefault(value);
        if (path.isEmpty() || path.equals("/")) return;
        contextPaths.add(SpringEndpointExtractor.joinPaths("", path));
    }

    /** `${CONTEXT_PATH:/api}` → `/api`; a placeholder without a default is unknown (""). */
    private static String placeholderDefault(String value) {
        Matcher m = Pattern.compile("^\\$\\{[^:}]+:([^}]*)}$").matcher(value);
        if (m.matches()) return m.group(1);
        return value.contains("${") ? "" : value;
    }

    private static String stripComment(String line) {
        boolean single = false;
        boolean dbl = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '\'' && !dbl) single = !single;
            else if (c == '"' && !single) dbl = !dbl;
            else if (c == '#' && !single && !dbl && (i == 0 || Character.isWhitespace(line.charAt(i - 1)))) {
                return line.substring(0, i).stripTrailing();
            }
        }
        return line.stripTrailing();
    }

    private static String unquote(String value) {
        if (value.length() >= 2 && (value.startsWith("\"") && value.endsWith("\"")
                || value.startsWith("'") && value.endsWith("'"))) {
            return value.substring(1, value.length() - 1);
        }
        return value;
    }

    private static List<String> reversed(Deque<String> keys) {
        List<String> list = new ArrayList<>(keys);
        java.util.Collections.reverse(list);
        return list;
    }

    private static final class RouteBuilder {
        final SourceLocation location;
        String id;
        String uri;
        final List<String> paths = new ArrayList<>();
        final List<PathRewrite> rewrites = new ArrayList<>();
        int stripPrefix;
        String prefixPath;
        String pendingRegex;

        RouteBuilder(SourceLocation location) {
            this.location = location;
        }

        /** Shortcut form, e.g. `Path=/a/**,/b/**` or `RewritePath=/api/(?<s>.*), /${s}`. */
        void apply(String name, String args) {
            switch (name) {
                case "Path" -> {
                    for (String p : args.split(",")) {
                        String path = unquote(p.strip());
                        if (path.startsWith("/")) paths.add(path);
                    }
                }
                case "RewritePath" -> {
                    String[] parts = args.split(",\\s*", 2);
                    if (parts.length == 2) rewrites.add(new PathRewrite(unquote(parts[0].strip()), unquote(parts[1].strip())));
                }
                case "StripPrefix" -> stripPrefix = parseInt(args);
                case "PrefixPath" -> prefixPath = args;
                default -> {}
            }
        }

        /** Fully expanded form: `- name: Path` followed by `args:` / `patterns: ...`. */
        void applyArg(String name, String key, String value) {
            if (name == null) return;
            switch (name) {
                case "Path" -> {
                    if (key.startsWith("pattern") || key.startsWith("_genkey_")) apply("Path", value);
                }
                case "RewritePath" -> {
                    if (key.equals("regexp")) pendingRegex = value;
                    else if (key.equals("replacement") && pendingRegex != null) {
                        rewrites.add(new PathRewrite(pendingRegex, value));
                        pendingRegex = null;
                    }
                }
                case "StripPrefix" -> {
                    if (key.equals("parts") || key.startsWith("_genkey_")) stripPrefix = parseInt(value);
                }
                case "PrefixPath" -> {
                    if (key.equals("prefix") || key.startsWith("_genkey_")) prefixPath = value;
                }
                default -> {}
            }
        }

        GatewayRouteInfo build() {
            return new GatewayRouteInfo(id, uri, List.copyOf(paths), List.copyOf(rewrites), stripPrefix, prefixPath,
                    location);
        }

        private static int parseInt(String value) {
            try {
                return Integer.parseInt(value.strip());
            } catch (NumberFormatException e) {
                return 0;
            }
        }
    }
}
