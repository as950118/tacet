import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@tacet-api/core": src("core"),
      "@tacet-api/extractor-typescript": src("extractor-typescript"),
      "@tacet-api/extractor-java": src("extractor-java"),
      "@tacet-api/cli": src("cli"),
      "@tacet-api/ai-anthropic": src("ai-anthropic"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
