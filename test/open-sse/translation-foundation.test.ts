import { describe, expect, test } from "bun:test";
import { classifyCompatibilityRejection, createTranslationContext, removeCompatibilityProjection } from "../../src/open-sse/translate";
import type { ClientProfile } from "../../src/open-sse/translate/detection";

const client: ClientProfile = {
  name: "claude-code",
  format: "anthropic-messages",
  source: "user-agent",
  formatSource: "endpoint",
  passthrough: "same-protocol-only",
};

describe("unified translation foundation", () => {
  test("creates immutable policy defaults without leaking payload state", () => {
    const context = createTranslationContext({
      source: { client, format: client.format, surface: "anthropic-messages" },
      target: {
        providerId: "codex",
        modelId: "claude-mythos-5",
        upstreamModelId: "gpt-5.6-luna",
        surface: "openai-responses",
        capabilities: {
          surfaces: ["openai-responses"],
          streaming: true,
          reasoning: { supported: true, efforts: ["xhigh"], maxTokens: "unsupported", summary: false, modes: [] },
          cache: { read: true, write: false, key: true, breakpoints: false, ttl: [], options: [] },
          tools: { function: true, native: [], parallel: true },
          response: { jsonObject: true, jsonSchema: true },
          media: { images: false, generation: [] },
        },
      },
      diagnostics: { record: () => {} },
    });
    expect(context.policy).toEqual({ preserveExtensions: true, retryOptionalCompatibility: true, emitDiagnostics: true });
    expect(context.target.upstreamModelId).toBe("gpt-5.6-luna");
  });

  test("classifies only explicit optional provider parameter rejections", () => {
    const rejection = classifyCompatibilityRejection({
      statusCode: 400,
      kind: "invalid_request",
      retryable: false,
      routeScope: "provider",
      source: "upstream",
      sanitizedMessage: "Unsupported parameter: prompt_cache_options",
      retryAt: null,
    });
    expect(rejection).toEqual({ category: "unsupported-cache", fieldPath: "prompt_cache_options", optional: true, retryable: true });
    expect(classifyCompatibilityRejection({ statusCode: 401, kind: "authentication_failed", retryable: false, routeScope: "account", source: "upstream", sanitizedMessage: "invalid key", retryAt: null })).toBeNull();
  });

  test("removes only rejected optional projections and preserves cache key", () => {
    const payload: Record<string, unknown> = {
      prompt_cache_key: "session-1",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      input: [{ type: "message", content: [{ type: "input_text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }] }],
      messages: [{ role: "system", content: [{ type: "text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }] }],
    };
    const rejection = classifyCompatibilityRejection({ statusCode: 400, kind: "invalid_request", retryable: false, routeScope: "provider", source: "upstream", sanitizedMessage: "Unsupported parameter: prompt_cache_options", retryAt: null });
    expect(rejection).not.toBeNull();
    expect(removeCompatibilityProjection(payload, rejection!)).toBe(true);
    expect(payload.prompt_cache_key).toBe("session-1");
    expect(payload.prompt_cache_options).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("prompt_cache_breakpoint");
  });
});
