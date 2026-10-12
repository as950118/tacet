plugins {
    java
}

group = "dev.tacet"
version = "0.1.1"

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.github.javaparser:javaparser-core:3.27.0")
    implementation("com.google.code.gson:gson:2.14.0")

    testImplementation(platform("org.junit:junit-bom:5.12.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// Runs on any JDK 17+, which is what Spring Boot 3 backends already require in CI.
tasks.withType<JavaCompile>().configureEach {
    options.release = 17
    options.encoding = "UTF-8"
}

tasks.jar {
    archiveFileName = "tacet-java-extractor.jar"
    manifest { attributes["Main-Class"] = "dev.tacet.java.Main" }
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) })
    exclude("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA", "**/module-info.class")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("tacet.fixtures", rootDir.resolve("../../../test/fixtures").canonicalPath)
}
