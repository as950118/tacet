plugins {
    `java-gradle-plugin`
    id("com.gradle.plugin-publish") version "1.3.1"
    signing
}

group = "io.github.as950118"
description = "Run Tacet in Gradle builds: find frontend code broken by backend API changes"

repositories {
    mavenCentral()
}

dependencies {
    testImplementation(platform("org.junit:junit-bom:5.12.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile>().configureEach {
    options.release = 17
    options.encoding = "UTF-8"
}

// The runner is shared with the Maven plugin as source, not as a separate artifact.
val generateVersion = tasks.register("generateTacetVersion") {
    val out = layout.buildDirectory.dir("generated/tacet")
    val pluginVersion = project.version.toString()
    inputs.property("version", pluginVersion)
    outputs.dir(out)
    doLast {
        val file = out.get().file("io/github/heonjinjeong/tacet/runner/tacet.properties").asFile
        file.parentFile.mkdirs()
        file.writeText("version=$pluginVersion\n")
    }
}
sourceSets.main {
    java.srcDir("../runner/src/main/java")
    resources.srcDir(generateVersion)
}

gradlePlugin {
    website = "https://github.com/as950118/tacet"
    vcsUrl = "https://github.com/as950118/tacet"
    plugins {
        create("tacet") {
            id = "io.github.as950118.tacet"
            implementationClass = "io.github.heonjinjeong.tacet.gradle.TacetPlugin"
            displayName = "Tacet"
            description = project.description
            tags = listOf("api", "breaking-changes", "contract-testing", "spring-boot", "typescript", "static-analysis")
        }
    }
}

signing {
    val key = providers.environmentVariable("SIGNING_KEY").orNull
    if (key != null) useInMemoryPgpKeys(key, providers.environmentVariable("SIGNING_PASSWORD").orNull)
    isRequired = key != null
}

tasks.test {
    useJUnitPlatform()
    systemProperty("tacet.repo", rootDir.resolve("../..").canonicalPath)
}

tasks.javadoc {
    (options as StandardJavadocDocletOptions).addStringOption("Xdoclint:all,-missing", "-quiet")
}
