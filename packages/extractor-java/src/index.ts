import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SubprocessExtractor, type BackendManifest, type LanguageExtractor } from "@tacet-api/core";

export const DEFAULT_JAR_PATH = fileURLToPath(
  new URL("../jvm/build/libs/tacet-java-extractor.jar", import.meta.url),
);

export interface JavaExtractorOptions {
  /** Defaults to $TACET_JAVA_EXTRACTOR_JAR, then the JAR built inside this package. */
  jarPath?: string;
  /** Defaults to $JAVA_HOME/bin/java, then `java` on PATH. */
  javaCommand?: string;
}

/** Runs the JavaParser-based extractor JAR (Spring Boot backends) through the subprocess extractor protocol. */
export class JavaExtractor implements LanguageExtractor<BackendManifest> {
  readonly language = "java" as const;
  readonly jarPath: string;
  private readonly javaCommand: string;

  constructor(options: JavaExtractorOptions = {}) {
    this.jarPath = resolve(options.jarPath ?? process.env.TACET_JAVA_EXTRACTOR_JAR ?? DEFAULT_JAR_PATH);
    this.javaCommand =
      options.javaCommand ??
      (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java");
  }

  async extract(rootDir: string): Promise<BackendManifest> {
    if (!existsSync(this.jarPath)) {
      throw new Error(
        `Java extractor JAR not found at ${this.jarPath}. ` +
          `Build it with "npm run build:jar -w @tacet-api/extractor-java" or set TACET_JAVA_EXTRACTOR_JAR.`,
      );
    }
    return new SubprocessExtractor<BackendManifest>({
      language: "java",
      command: this.javaCommand,
      args: ["-jar", this.jarPath],
    }).extract(resolve(rootDir));
  }
}
