package io.github.heonjinjeong.tacet.gradle;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.gradle.testkit.runner.BuildResult;
import org.gradle.testkit.runner.GradleRunner;
import org.gradle.testkit.runner.TaskOutcome;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TacetPluginTest {
    private static final Path REPO = Path.of(System.getProperty("tacet.repo"));
    private static final Path FIXTURES = REPO.resolve("test/fixtures");
    private static final Path CLI = REPO.resolve("packages/cli/dist/bin.js");

    @TempDir
    Path project;

    private void buildFile(String backend, String extra) throws IOException {
        Files.writeString(project.resolve("settings.gradle.kts"), "rootProject.name = \"backend\"\n");
        Files.writeString(project.resolve("build.gradle.kts"), """
                plugins { id("io.github.as950118.tacet") }
                tacet {
                    frontendDir.set(file("%s"))
                    backendDir.set(file("%s"))
                    config.set(file("%s"))
                    checkFailOn.set("never")
                    command.set(listOf("node", "%s"))
                    %s
                }
                """.formatted(FIXTURES.resolve("frontend"), FIXTURES.resolve(backend),
                FIXTURES.resolve("tacet.config.json"), CLI, extra));
    }

    private GradleRunner runner(String... args) {
        return GradleRunner.create().withProjectDir(project.toFile()).withPluginClasspath().withArguments(args).forwardOutput();
    }

    @Test
    void storesTheBaselineThenFailsTheBuildOnBreakingChanges() throws IOException {
        buildFile("backend", "");
        BuildResult first = runner("tacetCheck", "--configuration-cache").build();
        assertEquals(TaskOutcome.SUCCESS, first.task(":tacetCheck").getOutcome());
        assertTrue(Files.readString(project.resolve("build/tacet/report.md")).contains("No git base ref"));

        buildFile("backend-v2", "");
        BuildResult second = runner("tacetCheck", "--configuration-cache").buildAndFail();
        assertTrue(second.getOutput().contains("Tacet found problems at the configured failure level"), second.getOutput());
        assertTrue(Files.readString(project.resolve("build/tacet/report.md")).contains("backend API change report: FAIL"));
    }

    @Test
    void ignoreFailuresOnlyWarns() throws IOException {
        buildFile("backend", "");
        runner("tacetCheck").build();
        buildFile("backend-v2", "ignoreFailures.set(true)");
        BuildResult result = runner("tacetCheck").build();
        assertTrue(result.getOutput().contains("Tacet found problems"), result.getOutput());
    }

    @Test
    void rejectsInvalidOptions() throws IOException {
        buildFile("backend", "failOn.set(\"sometimes\")");
        BuildResult result = runner("tacetCheck").buildAndFail();
        assertTrue(result.getOutput().contains("`failOn` must be one of"), result.getOutput());
    }
}
