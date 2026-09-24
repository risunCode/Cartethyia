import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/transport/canonical-model";
import {
  applyDeepSeekReasoning,
  applyOpenAIReasoning,
  backfillDeepSeekReasoningContent,
  buildAnthropicThinkingPayload,
  geminiThinkingOutputFloor,
} from "../../src/providers/reasoning";

const request = (reasoning: CanonicalRequest["reasoning"]): CanonicalRequest => ({
  model: "reasoning-model",
  messages: [],
  generation_controls: {},
  stream: true,
  source_surface: "chat",
  ...(reasoning === undefined ? {} : { reasoning }),
});

describe("shared provider reasoning normalization", () => {
  test("projects canonical effort and budget onto OpenAI controls", () => {
    const payload: Record<string, unknown> = {};
    applyOpenAIReasoning(payload, request({ thinking_type: "enabled", budget_tokens: 4096 }));
    expect(payload.reasoning_effort).toBe("high");
  });

  test("applies DeepSeek thinking and assistant replay requirements", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "assistant", content: "answer" }],
    };
    applyDeepSeekReasoning(payload);
    backfillDeepSeekReasoningContent(payload);
    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.reasoning_effort).toBe("high");
    // A turn with no reasoning trace must NOT gain an empty `reasoning_content`:
    // the upstream reads that as thinking-mode-with-the-reasoning-stripped and
    // rejects the next turn ("the reasoning content from the previous turn must
    // be passed back in thinking mode").
    expect((payload.messages as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      "reasoning_content",
    );
  });

  test("backfills reasoning_content only from a real trace", () => {
    const payload: Record<string, unknown> = {
      thinking: { type: "enabled" },
      messages: [
        { role: "assistant", reasoning: "because reasons", content: "answer" },
        { role: "assistant", content: "no trace here" },
      ],
    };
    backfillDeepSeekReasoningContent(payload);
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.reasoning_content).toBe("because reasons");
    expect(messages[1]).not.toHaveProperty("reasoning_content");
  });

  test("leaves explicitly disabled DeepSeek thinking disabled", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      thinking: { type: "disabled" },
      reasoning_effort: "high",
    };
    applyDeepSeekReasoning(payload);
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.reasoning_effort).toBeUndefined();
  });

  test("derives Gemini output floors from canonical reasoning", () => {
    expect(geminiThinkingOutputFloor({ thinking_type: "enabled", budget_tokens: 4096 })).toBe(16_384);
    expect(geminiThinkingOutputFloor({ thinking_type: "disabled", budget_tokens: 4096 })).toBeUndefined();
  });

  test("builds the Anthropic thinking block from canonical intent", () => {
    expect(
      buildAnthropicThinkingPayload({
        thinking_type: "enabled",
        budget_tokens: 4096,
        display: "updates",
        prefix_mismatch_behavior: "drop_block",
      }),
    ).toEqual({
      type: "enabled",
      budget_tokens: 4096,
      display: "updates",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
  });
});
