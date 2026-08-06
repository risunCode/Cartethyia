import { describe, expect, test } from "bun:test";
import { buildCachePlan } from "../../src/domain/cache";
import { normalizeRequest } from "../../src/domain/protocols";
import { buildChatPayload } from "../../src/domain/protocols/openai-chat";

describe("protocol normalization", () => {
  test("normalizes chat JSON and keeps cache marking in memory", () => {
    const result = normalizeRequest("/v1/chat/completions", {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Hello" },
      ],
      stream: false,
      response_format: { type: "json_object" },
    }, {
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.responseFormat).toBe("json_object");
    const plan = buildCachePlan(result.request);
    expect(plan.hasStablePrefix).toBe(true);
    expect(plan.sections.some((section) => section.kind === "static_context")).toBe(true);
  });

  test("preserves OpenAI reasoning_content for thinking follow-up turns", () => {
    const result = normalizeRequest("/v1/chat/completions", {
      model: "gpt-5",
      messages: [
        { role: "assistant", content: "", reasoning_content: "The hidden reasoning must round-trip." },
        { role: "user", content: "Continue." },
      ],
      stream: false,
    }, {
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = buildChatPayload(result.request);
    expect((payload.messages as Array<Record<string, unknown>>)[0]).toMatchObject({ reasoning_content: "The hidden reasoning must round-trip." });
  });

  test("rejects malformed JSON before provider selection", () => {
    const result = normalizeRequest("/v1/chat/completions", { messages: [] }, {
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 },
    });
    expect(result.ok).toBe(false);
  });
});
