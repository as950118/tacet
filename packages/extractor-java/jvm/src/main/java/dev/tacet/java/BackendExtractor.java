package dev.tacet.java;

import dev.tacet.java.model.Manifest.BackendManifest;
import dev.tacet.java.model.Manifest.EndpointInfo;
import dev.tacet.java.model.Manifest.ServiceCallInfo;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** Produces a {@link BackendManifest} for a Spring backend source tree. */
public final class BackendExtractor {

    public BackendManifest extract(Path rootDir) throws IOException {
        Path root = rootDir.toAbsolutePath().normalize();
        List<String> warnings = new ArrayList<>();
        SourceIndex index = SourceIndex.load(root, warnings);
        TypeModel types = new TypeModel(index, warnings);
        List<EndpointInfo> endpoints = new SpringEndpointExtractor(index, types, warnings).extract();
        List<ServiceCallInfo> serviceCalls = new ServiceClientExtractor(index, warnings).extract();
        SpringConfigExtractor config = new SpringConfigExtractor(index, warnings);
        config.extract();
        return new BackendManifest(
                "java", root.toString(), Instant.now().toString(), endpoints, types.dtos(), types.enums(),
                serviceCalls, config.routes(), config.contextPaths(), List.copyOf(warnings));
    }
}
