import { describe, expect, test } from "bun:test";
import { createGeminiMapper } from "../../src/transport/protocols/gemini";
import { ProviderAdapterError } from "../../src/providers/shared";
import type { SseEvent } from "../../src/providers/shared";

function sse(data: string): SseEvent {
  return { event: null, data };
}

describe("createGeminiMapper", () => {
  test("emits message_start (with responseId) and text_delta for text parts", () => {
    const mapper = createGeminiMapper();
    const events = mapper(sse(JSON.stringify({ responseId: "gem-1", candidates: [{ content: { parts: [{ text: "hel" }] } }] })));
    expect(events).toEqual([
      { type: "message_start", id: "gem-1" },
      { type: "text_delta", text: "hel" },
    ]);
  });

  test("synthesizes a gemini-<uuid> id when responseId is absent", () => {
    const mapper = createGeminiMapper();
    const events = mapper(sse(JSON.stringify({ candidates: [{ content: { parts: [{ text: "lo" }] } }] })));
    expect(Array.isArray(events)).toBe(true);
    const start = (events as readonly { type: string; id: string }[])[0];
    expect(start?.type).toBe("message_start");
    expect(start?.id).toMatch(/^gemini-[0-9a-f-]{36}$/);
  });

  test("routes a thought part to thinking_delta, not text_delta", () => {
    const mapper = createGeminiMapper();
    const events = mapper(sse(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hidden reasoning", thought: true }] } }] })));
    expect(events).toContainEqual({ type: "thinking_delta", text: "hidden reasoning" });
    expect(events).not.toContainEqual({ type: "text_delta", text: "hidden reasoning" });
  });

  test("emits tool_call_start and tool_call_delta for a functionCall with args", () => {
    const mapper = createGeminiMapper();
    const events = mapper(sse(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: "call_1", name: "lookup", args: { q: "x" } } }] } }] })));
    expect(events).toContainEqual({ type: "tool_call_start", callId: "call_1", name: "lookup" });
    expect(events).toContainEqual({ type: "tool_call_delta", callId: "call_1", delta: JSON.stringify({ q: "x" }) });
  });

  test("omits tool_call_delta when args serialize to an empty object", () => {
    const mapper = createGeminiMapper();
    const events = mapper(sse(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: "call_2", name: "ping", args: {} } }] } }] })));
    expect(events).toContainEqual({ type: "tool_call_start", callId: "call_2", name: "ping" });
    expect((events as readonly { type: string }[]).some((e) => e.type === "tool_call_delta")).toBe(false);
  });

  test("emits a usage event when usageMetadata is present", () => {
    const mapper = createGeminiMapper();
    const events = mapper(sse(JSON.stringify({ usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7, cachedContentTokenCount: 2 } })));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7, cacheReadTokens: 2, cacheWriteTokens: null, source: "provider" } });
  });

  test("maps a MAX_TOKENS finishReason to a length stop with no tool_call_end", () => {
    const mapper = createGeminiMapper();
    const events = mapper(sse(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "cut" }] } }] })));
    expect(events).toContainEqual({ type: "text_delta", text: "cut" });
    expect(events).toContainEqual({ type: "message_stop", reason: "length" });
    expect((events as readonly { type: string }[]).some((e) => e.type === "tool_call_end")).toBe(false);
  });

  test("emits tool_call_end and a completed stop when a call was active at finish", () => {
    const mapper = createGeminiMapper();
    mapper(sse(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: "call_1", name: "lookup", args: { q: "x" } } }] } }] })));
    const stop = mapper(sse(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [] } }] })));
    expect(stop).toContainEqual({ type: "tool_call_end", callId: "call_1" });
    // The stop reason is derived from the STOP event's own parts (no calls there),
    // so it resolves to "completed" — not "tool_call" — even though a call was active.
    expect(stop).toContainEqual({ type: "message_stop", reason: "completed" });
  });

  test("maps a STOP finishReason with no calls to a completed stop", () => {
    const mapper = createGeminiMapper();
    const events = mapper(sse(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "done" }] } }] })));
    expect(events).toContainEqual({ type: "message_stop", reason: "completed" });
  });

  test("throws ProviderAdapterError when the stream carries an error object", () => {
    const mapper = createGeminiMapper();
    expect(() => mapper(sse(JSON.stringify({ error: { message: "quota exceeded" } })))).toThrow(ProviderAdapterError);
  });

  test("returns null for non-JSON or non-object data", () => {
    const mapper = createGeminiMapper();
    expect(mapper(sse("not-json"))).toBe(null);
    expect(mapper(sse("[1,2,3]"))).toBe(null);
  });

  test("returns null for a follow-up event that carries no text, calls, usage, or finish", () => {
    const mapper = createGeminiMapper();
    // The first event always emits message_start (the !started rule), so prime it
    // with a real text event, then a subsequent empty-parts event returns null.
    mapper(sse(JSON.stringify({ responseId: "gem-1", candidates: [{ content: { parts: [{ text: "hi" }] } }] })));
    expect(mapper(sse(JSON.stringify({ candidates: [{ content: { parts: [] } }] })))).toBe(null);
  });
});
