import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import {
  buildVerificationPrompt,
  type AiProvider,
  type AiVerificationRequest,
  type AiVerificationResponse,
} from "@api-tacet/core";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicProviderOptions {
  /** Defaults to $TACET_AI_MODEL, then claude-opus-5. */
  model?: string;
  /** Thinking depth / token spend. Omitted = the API default (high). */
  effort?: Effort;
  /** Inject a configured client (proxy, timeouts, Bedrock/Vertex clients, tests). */
  client?: Anthropic;
}

const VerdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      result: z.enum(["PASS", "WARNING", "FAIL", "UNKNOWN"]),
      confidence: z.number(),
      reason: z.string(),
      evidence: z.array(z.object({ file: z.string(), line: z.number().int(), code: z.string() })),
    }),
  ),
});

export class AiVerificationError extends Error {}

/**
 * Claude as the Tacet verification layer. Uses structured outputs so the
 * verdicts always match the schema, and server-side refusal fallbacks so a
 * declined request is retried on a fallback model inside the same call.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort?: Effort;

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? process.env.TACET_AI_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    this.effort = options.effort;
    // Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    this.client = options.client ?? new Anthropic();
  }

  async verify(request: AiVerificationRequest): Promise<AiVerificationResponse> {
    const prompt = buildVerificationPrompt(request);
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: {
          format: betaZodOutputFormat(VerdictsSchema),
          ...(this.effort ? { effort: this.effort } : {}),
        },
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      });
    } catch (err) {
      throw new AiVerificationError(describeError(err));
    }

    if (response.stop_reason === "refusal") {
      const details = response.stop_details;
      throw new AiVerificationError(
        `The model declined the request${details?.category ? ` (${details.category})` : ""}${details?.explanation ? `: ${details.explanation}` : ""}`,
      );
    }
    if (response.stop_reason === "max_tokens") {
      throw new AiVerificationError("The response hit max_tokens before the verdicts were complete");
    }
    if (!response.parsed_output) {
      throw new AiVerificationError("The response did not contain parseable verdicts");
    }
    return { model: response.model, verdicts: response.parsed_output.verdicts };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Anthropic authentication failed: set ANTHROPIC_API_KEY or run `ant auth login`";
  }
  if (err instanceof Anthropic.PermissionDeniedError) return `Anthropic permission denied: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `Model or endpoint not found: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit reached; retry later";
  if (err instanceof Anthropic.BadRequestError) return `Anthropic rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`.trim();
  // Anything else failed before a response came back (network, or the client could not resolve credentials).
  const message = err instanceof Error ? err.message : String(err);
  return `Anthropic request failed before reaching the API: ${message} (if credentials are missing, set ANTHROPIC_API_KEY or run \`ant auth login\`)`;
}
