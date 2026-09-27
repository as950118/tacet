package io.github.heonjinjeong.tacet.runner;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;
import java.util.function.Consumer;

/**
 * Runs `tacet ci` for the Gradle and Maven plugins. The analysis itself lives in the Tacet CLI
 * (npm package {@code @tacet-api/cli}); this class only locates it, builds the arguments and runs it.
 */
public final class TacetRunner {
    private TacetRunner() {}

    /** Outcome of one `tacet ci` run. */
    public record Result(int exitCode, Path report, Path json, List<String> command) {
        public boolean failed() {
            return exitCode != 0;
        }
    }

    /**
     * The CLI invocation: the configured command, else `tacet` on PATH, else the npm release that
     * matches this plugin's version through npx.
     */
    public static List<String> resolveCommand(List<String> configured, Map<String, String> env) {
        if (configured != null && !configured.isEmpty()) return List.copyOf(configured);
        String path = env.getOrDefault("PATH", env.getOrDefault("Path", ""));
        Optional<Path> tacet = findExecutable("tacet", path);
        if (tacet.isPresent()) return List.of(tacet.get().toString());
        Optional<Path> npx = findExecutable("npx", path);
        if (npx.isPresent()) return List.of(npx.get().toString(), "--yes", "@tacet-api/cli@" + version());
        throw new IllegalStateException(
                "Tacet CLI not found. Install Node.js 22.13+ (the plugin then runs @tacet-api/cli through npx), "
                        + "run `npm install -g @tacet-api/cli`, or set the plugin's `command` option.");
    }

    /** Arguments for `tacet ci`, after the CLI command itself. */
    public static List<String> ciArguments(TacetSettings s) {
        List<String> args = new ArrayList<>(List.of(
                "--index", s.indexFile().toString(),
                "ci",
                "--frontend", s.frontendDir().toString(),
                "--backend", s.backendDir().toString(),
                "--out", s.outputDir().toString(),
                "--fail-on", s.failOn(),
                "--check-fail-on", s.checkFailOn(),
                "--verify-fail-on", s.verifyFailOn()));
        if (s.config() != null) args.addAll(0, List.of("--config", s.config().toString()));
        if (notBlank(s.base())) args.addAll(List.of("--base", s.base()));
        if (notBlank(s.aiProvider())) args.addAll(List.of("--ai-provider", s.aiProvider()));
        if (notBlank(s.aiModel())) args.addAll(List.of("--ai-model", s.aiModel()));
        return args;
    }

    public static Result run(TacetSettings settings, Map<String, String> env, Consumer<String> log)
            throws IOException, InterruptedException {
        List<String> command = new ArrayList<>(resolveCommand(settings.command(), env));
        command.addAll(ciArguments(settings));
        Files.createDirectories(settings.outputDir());

        ProcessBuilder builder = new ProcessBuilder(command)
                .directory(settings.workingDir().toFile())
                .redirectErrorStream(true);
        builder.environment().putAll(env);
        Process process = builder.start();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            reader.lines().forEach(log);
        }
        int exit = process.waitFor();
        if (exit > 1) {
            throw new IOException("Tacet CLI failed (exit code " + exit + "): " + String.join(" ", command));
        }
        return new Result(exit, settings.outputDir().resolve("report.md"), settings.outputDir().resolve("report.json"), command);
    }

    /** The plugin version, used to pin the npm release. */
    public static String version() {
        try (InputStream in = TacetRunner.class.getResourceAsStream("/io/github/heonjinjeong/tacet/runner/tacet.properties")) {
            Properties props = new Properties();
            if (in != null) props.load(in);
            return props.getProperty("version", "latest");
        } catch (IOException e) {
            return "latest";
        }
    }

    static Optional<Path> findExecutable(String name, String path) {
        boolean windows = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
        List<String> names = windows ? List.of(name + ".cmd", name + ".exe", name) : List.of(name);
        for (String dir : path.split(File.pathSeparator)) {
            if (dir.isBlank()) continue;
            for (String candidate : names) {
                Path file = Path.of(dir, candidate);
                if (Files.isRegularFile(file) && Files.isExecutable(file)) return Optional.of(file);
            }
        }
        return Optional.empty();
    }

    private static boolean notBlank(String value) {
        return value != null && !value.isBlank();
    }
}
