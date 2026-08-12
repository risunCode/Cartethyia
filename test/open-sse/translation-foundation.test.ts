import { describe, expect, test } from "bun:test";
import { classifyCompatibilityRejection, createTranslationContext, decideProviderRetry, removeCompatibilityProjection } from "../../src/open-sse/translate";
import type { ClientProfile } from "../../src/open-sse/translate/detection";
import type { ProviderCallError } from "../../src/application/contracts";

function providerError(overrides: Partial<ProviderCallError> = {}): ProviderCallError {
  return {
    statusCode: null,
    kind: "provider_protocol_error",
    retryable: false,
    routeScope: "provider",
    source: "upstream",
    sanitizedMessage: "Provider request failed",
    retryAt: null,
    ...overrides,
  };
}

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

  test("honors a stable optional rejection code over status and message fallback", () => {
    const rejection = classifyCompatibilityRejection(providerError({
      statusCode: 422,
      failureCode: "optional_parameter_rejected",
      sanitizedMessage: "provider rejected prompt_cache_options",
    }));
    expect(rejection).toEqual({ category: "unsupported-cache", fieldPath: "prompt_cache_options", optional: true, retryable: true });
    expect(classifyCompatibilityRejection(providerError({
      statusCode: 400,
      failureCode: "context_overflow",
      sanitizedMessage: "Unsupported parameter: prompt_cache_options",
    }))).toBeNull();
  });

  test("allows one pre-content retry for provider-local state and body failures", () => {
    const safeState = { phase: "pre_content" as const, output: "lifecycle" as const, retryCount: 0 };
    for (const failureCode of ["stale_response_state", "empty_provider_body", "provider_finish_error", "optional_parameter_rejected"] as const) {
      expect(decideProviderRetry(providerError({ failureCode }), safeState)).toEqual({ retryable: true, reason: failureCode });
    }
    expect(decideProviderRetry(providerError({ failureCode: "empty_provider_body" }), { ...safeState, retryCount: 1 })).toEqual({ retryable: false, reason: "retry_exhausted" });
  });

  test("rejects unsafe output, blocked failures, and caller aborts", () => {
    expect(decideProviderRetry(providerError({ failureCode: "context_overflow" }), { phase: "pre_content", output: "none" })).toEqual({ retryable: false, reason: "context_overflow" });
    expect(decideProviderRetry(providerError({ failureCode: "content_blocked" }), { phase: "pre_content", output: "none" })).toEqual({ retryable: false, reason: "content_blocked" });
    expect(decideProviderRetry(providerError({ failureCode: "caller_aborted" }), { phase: "pre_content", output: "none" })).toEqual({ retryable: false, reason: "caller_aborted" });
    expect(decideProviderRetry(providerError({ failureCode: "empty_provider_body" }), { phase: "post_semantic", output: "semantic" })).toEqual({ retryable: false, reason: "semantic_output" });
    expect(decideProviderRetry(providerError({ failureCode: "provider_finish_error" }), { phase: "streaming", output: "none" })).toEqual({ retryable: false, reason: "post_semantic_failure" });
  });

  test("removes only rejected optional projections and preserves semantic fields", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "stable" }] }];
    const tools = [{ type: "function", function: { name: "lookup" } }];
    const payload: Record<string, unknown> = {
      model: "gpt-5",
      authorization: "Bearer [redacted]",
      messages,
      tools,
      prompt_cache_key: "session-1",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      input: [{ type: "message", content: [{ type: "input_text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }] }],
    };
    const rejection = classifyCompatibilityRejection(providerError({
      statusCode: 400,
      sanitizedMessage: "Unsupported parameter: prompt_cache_options",
    }));
    expect(rejection).not.toBeNull();
    expect(removeCompatibilityProjection(payload, rejection!)).toBe(true);
    expect(payload.model).toBe("gpt-5");
    expect(payload.authorization).toBe("Bearer [redacted]");
    expect(payload.messages).toEqual(messages);
    expect(payload.tools).toEqual(tools);
    expect(payload.prompt_cache_key).toBe("session-1");
    expect(payload.prompt_cache_options).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("prompt_cache_breakpoint");
    expect(removeCompatibilityProjection(payload, { category: "unsupported-field", fieldPath: "messages", optional: true, retryable: true })).toBe(false);
    expect(payload.messages).toEqual(messages);
  });
});
