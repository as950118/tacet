import type { AiProvider } from "@tacet-api/core";
import { AnthropicProvider, type Effort } from "@tacet-api/ai-anthropic";

export const AI_PROVIDERS = ["anthropic"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export interface CreateAiProviderOptions {
  model?: string;
  effort?: Effort;
}

/** Providers are plain `AiProvider` implementations; add new ones here. */
export function createAiProvider(name: string, options: CreateAiProviderOptions = {}): AiProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(options);
    default:
      throw new Error(`Unknown AI provider "${name}". Available: ${AI_PROVIDERS.join(", ")}`);
  }
}
