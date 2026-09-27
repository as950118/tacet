import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { AiVerificationRequest } from "@tacet-api/core";
import { AiVerificationError, AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "../src/index.js";

const REQUEST: AiVerificationRequest = {
  endpointId: "GET /users/{id}",
  handler: "UserController#getUser",
  changes: [{ message: "Response `age` type changed: int → String", breaking: true }],
  beforeSchema: "{ age: number }",
  afterSchema: "{ age: string }",
  candidates: [
    { id: "c1", staticConfidence: "LIKELY", staticReason: "Reads `age`", file: "src/a.ts", line: 3, code: "user.age", functionName: "show", component: null },
  ],
  snippets: [{ file: "src/a.ts", startLine: 1, lines: ["", "", "return user.age + 1;"] }],
};

function fakeClient(response: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params);
          return response;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const VERDICTS = {
  verdicts: [{ id: "c1", result: "FAIL", confidence: 0.9, reason: "String + 1", evidence: [{ file: "src/a.ts", line: 3, code: "user.age + 1" }] }],
};

describe("AnthropicProvider", () => {
  it("sends the vendor-neutral prompt with structured output, adaptive thinking and refusal fallbacks", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", model: "claude-opus-5", parsed_output: VERDICTS });
    const provider = new AnthropicProvider({ client, model: undefined });
    const result = await provider.verify(REQUEST);

    expect(result).toEqual({ model: "claude-opus-5", verdicts: VERDICTS.verdicts });
    const params = calls[0];
    expect(params).toMatchObject({
      model: process.env.TACET_AI_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
    });
    expect((params.output_config as { format: unknown }).format).toBeDefined();
    expect(params).not.toHaveProperty("temperature");
    expect(String(params.system)).toContain("must cite evidence");
    expect((params.messages as { content: string }[])[0].content).toContain("<endpoint>GET /users/{id}");
  });

  it("passes effort through output_config", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", model: "m", parsed_output: VERDICTS });
    await new AnthropicProvider({ client, effort: "low", model: "claude-sonnet-5" }).verify(REQUEST);
    expect(calls[0]).toMatchObject({ model: "claude-sonnet-5", output_config: { effort: "low" } });
  });

  it.each([
    [{ stop_reason: "refusal", stop_details: { category: "cyber", explanation: "no" }, model: "m", parsed_output: null }, "declined the request (cyber): no"],
    [{ stop_reason: "max_tokens", model: "m", parsed_output: null }, "max_tokens"],
    [{ stop_reason: "end_turn", model: "m", parsed_output: null }, "parseable verdicts"],
  ])("turns %j into an AiVerificationError", async (response, message) => {
    const { client } = fakeClient(response);
    await expect(new AnthropicProvider({ client }).verify(REQUEST)).rejects.toThrow(AiVerificationError);
    await expect(new AnthropicProvider({ client }).verify(REQUEST)).rejects.toThrow(message);
  });
});
