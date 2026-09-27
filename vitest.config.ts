import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@api-tacet/core": src("core"),
      "@api-tacet/extractor-typescript": src("extractor-typescript"),
      "@api-tacet/extractor-java": src("extractor-java"),
      "@api-tacet/cli": src("cli"),
      "@api-tacet/ai-anthropic": src("ai-anthropic"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
