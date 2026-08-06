import { describe, expect, test } from "bun:test";
import { applyTokenSaver } from "../../src/domain/token-saver";
import type { NormalizedProviderRequest } from "../../src/domain/contracts";

const base: NormalizedProviderRequest = {
  model: "test",
  messages: [
    { role: "user", content: [{ type: "text", text: "older request" }] },
    { role: "tool", content: [{ type: "tool_result", text: "z".repeat(10_000) }] },
    { role: "user", content: [{ type: "text", text: "request" }] },
    { role: "tool", content: [{ type: "tool_result", text: "x".repeat(10_000) }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
    { role: "tool", content: [{ type: "tool_result", text: "y".repeat(10_000) }] },
  ],
  tools: [], stream: false, responseFormat: "text", reasoning: "default", maxOutputTokens: null, images: [], sourceSurface: "openai-chat", signal: new AbortController().signal,
  limits: { maxBodyBytes: 100_000, connectTimeoutMs: 100, firstByteTimeoutMs: 100, idleTimeoutMs: 100, totalTimeoutMs: 1000 },
};

describe("Token Saver", () => {
  test("balanced compresses old tool results while protecting recent turns", () => {
    const result = applyTokenSaver(base, { enabled: true, quality: "balanced" });
    expect(result.messages[1]?.content[0]?.text?.length).toBeLessThan(10_000);
    expect(result.messages[3]?.content[0]?.text).toHaveLength(10_000);
  });

  test("preserves git diff hunk headers in smart truncation", () => {
    const diff = Array.from({ length: 500 }, (_, index) => index === 0 ? "@@ -1,40 +1,40 @@" : `+changed line ${index}`).join("\n");
    const request = { ...base, messages: [{ role: "tool" as const, content: [{ type: "tool_result" as const, text: diff }] }, ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "balanced" });
    expect(result.messages[0]?.content[0]?.text).toContain("@@ -1,40 +1,40 @@");
    expect(result.messages[0]?.content[0]?.text?.length).toBeLessThan(diff.length);
  });

  test("collapses repeated log lines even below the lossy size threshold", () => {
    const repeated = Array.from({ length: 200 }, () => "same log line").join("\n");
    const request = { ...base, messages: [{ role: "tool" as const, content: [{ type: "tool_result" as const, text: repeated }] }, ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "balanced" });
    expect(result.messages[0]?.content[0]?.text).toContain("duplicate lines");
  });

  test("disabled mode preserves the canonical request", () => {
    expect(applyTokenSaver(base, { enabled: false, quality: "extreme" })).toBe(base);
  });
});
