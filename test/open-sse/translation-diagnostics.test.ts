import { describe, expect, test } from "bun:test";
import { boundedTranslationDiagnostics, detectClientFormat, diagnosticsForDetection, normalizationEndpoint } from "../../src/open-sse/translate";

describe("translation diagnostics", () => {
  test("records format adaptation without client secrets or payloads", () => {
    const headers = new Headers({ "x-client-name": "codex", authorization: "Bearer secret-value" });
    const detection = detectClientFormat("/v1/chat/completions", "openai-chat", headers, { input: "hello", model: "gpt-5" });
    const diagnostics = diagnosticsForDetection("/v1/chat/completions", "openai-chat", detection, normalizationEndpoint("/v1/chat/completions", detection));
    expect(diagnostics).toEqual([
      {
        stage: "normalization",
        sourceFormat: "cursor-chat-hybrid",
        targetSurface: "openai-chat",
        fieldCategory: "wire-surface",
        action: "adapted",
        reason: "body shape selected /v1/responses codec",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret-value");
    expect(JSON.stringify(diagnostics)).not.toContain("hello");
  });

  test("bounds and redacts arbitrary diagnostic input", () => {
    const diagnostics = boundedTranslationDiagnostics(Array.from({ length: 40 }, (_, index) => ({
      stage: "request",
      sourceFormat: "untrusted-secret-format",
      targetSurface: "openai-chat",
      fieldCategory: "tool-arguments",
      action: "dropped",
      reason: index === 0 ? "authorization: super-secret {\"password\":\"hidden\"}" : `reason-${index}`,
    })));
    expect(diagnostics).toHaveLength(32);
    expect(diagnostics[0]!.sourceFormat).toBe("unknown");
    expect(diagnostics[0]!.reason).toBe("redacted structured detail");
    expect(diagnostics.every((diagnostic) => diagnostic.reason.length <= 160)).toBe(true);
  });
});
