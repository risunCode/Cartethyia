/** OpenAI-shaped `reasoning_effort` -> Anthropic native `thinking` translation, so Model Studio's "Think" selector (and any future OpenAI-shaped caller) actually enables extended thinking on Anthropic-family targets instead of the field being silently dropped. */

import { describe, expect, test } from "bun:test";
import { translateChatRequestToAnthropic } from "../../src/translate/openai-anthropic";
import type { OpenAIChatRequest } from "../../src/translate/types";

const base: OpenAIChatRequest = {
  model: "claude-test",
  messages: [{ role: "user", content: "hi" }],
};

describe("translateChatRequestToAnthropic — reasoning_effort", () => {
  test("omits thinking when reasoning_effort is absent", () => {
    const out = translateChatRequestToAnthropic(base);
    expect(out.thinking).toBeUndefined();
  });

  test("maps a known effort level to a thinking budget", () => {
    const out = translateChatRequestToAnthropic({ ...base, reasoning_effort: "high" } as OpenAIChatRequest);
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 12000 });
  });

  test("floors max_tokens above the thinking budget", () => {
    const out = translateChatRequestToAnthropic({ ...base, reasoning_effort: "max", max_tokens: 1024 } as OpenAIChatRequest);
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 32000 });
    expect(out.max_tokens).toBeGreaterThan(32000);
  });

  test("never lowers a max_tokens the client explicitly requested above the budget floor", () => {
    const out = translateChatRequestToAnthropic({ ...base, reasoning_effort: "low", max_tokens: 100000 } as OpenAIChatRequest);
    expect(out.max_tokens).toBe(100000);
  });

  test("ignores an unrecognized effort level instead of erroring", () => {
    const out = translateChatRequestToAnthropic({ ...base, reasoning_effort: "not-a-real-level" } as OpenAIChatRequest);
    expect(out.thinking).toBeUndefined();
  });

  test("ignores a non-string reasoning_effort instead of erroring", () => {
    const out = translateChatRequestToAnthropic({ ...base, reasoning_effort: 42 } as unknown as OpenAIChatRequest);
    expect(out.thinking).toBeUndefined();
  });
});
