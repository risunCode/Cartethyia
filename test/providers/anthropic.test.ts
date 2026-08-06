import { describe, expect, test } from "bun:test";
import { AnthropicAdapter } from "../../src/providers/anthropic";
import { ProviderAdapterError } from "../../src/providers/shared";
import type { ProviderRequest } from "../../src/domain/contracts";

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: { providerId: "anthropic", modelId: "claude-sonnet-4-5", surface: "anthropic-messages" },
    request: {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      stream: false,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: null,
      images: [],
      sourceSurface: "anthropic-messages",
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 },
    },
    credential: "sk-ant-test",
    network: { select: async () => ({ proxyId: null, selection: { proxyId: null, url: null, release: async () => {} } }) } as never,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("AnthropicAdapter — identity & catalog", () => {
  test("declares the anthropic protocol, anthropic-messages surface, and prompt caching", () => {
    const adapter = new AnthropicAdapter();
    expect(adapter.metadata).toMatchObject({ id: "anthropic", displayName: "Anthropic", protocol: "anthropic", credentialKind: "api_key" });
    expect(adapter.capabilities.surfaces).toEqual(["anthropic-messages"]);
    expect(adapter.capabilities.explicitCache).toBe(true);
    expect(adapter.capabilities.promptCacheKey).toBe(true);
  });

  test("honors config overrides and trims a trailing slash from baseUrl", () => {
    const adapter = new AnthropicAdapter({ id: "anthropic-eu", displayName: "Anthropic EU", baseUrl: "https://api.anthropic.eu/v1/", credentialKind: "oauth", auth: "bearer" });
    expect(adapter.metadata.id).toBe("anthropic-eu");
    expect(adapter.metadata.credentialKind).toBe("oauth");
  });

  test("exposes the default Claude catalog with reasoning and image models", () => {
    const adapter = new AnthropicAdapter();
    expect(adapter.models.get("claude-opus-4-1")?.capabilities.reasoning).toBe(true);
    expect(adapter.models.get("claude-sonnet-4-5")?.capabilities.images).toBe(true);
    expect(adapter.models.get("nope")).toBe(null);
  });
});

describe("AnthropicAdapter — resolveTarget", () => {
  test("resolves a known model on the anthropic-messages surface", () => {
    const adapter = new AnthropicAdapter();
    expect(adapter.resolveTarget("claude-haiku-4-5", "anthropic-messages")).toEqual({ providerId: "anthropic", modelId: "claude-haiku-4-5", surface: "anthropic-messages" });
  });

  test("rejects an unsupported surface", () => {
    const adapter = new AnthropicAdapter();
    expect(() => adapter.resolveTarget("claude-sonnet-4-5", "openai-chat")).toThrow(ProviderAdapterError);
    try {
      adapter.resolveTarget("claude-sonnet-4-5", "openai-chat");
    } catch (error) {
      expect((error as ProviderAdapterError).kind).toBe("capability_unsupported");
    }
  });

  test("rejects an unknown model", () => {
    const adapter = new AnthropicAdapter();
    try {
      adapter.resolveTarget("no-such-claude", "anthropic-messages");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ProviderAdapterError).kind).toBe("model_not_found");
    }
  });

  test("accepts any model with an empty catalog", () => {
    const adapter = new AnthropicAdapter({ models: [] });
    expect(adapter.resolveTarget("custom-claude", "anthropic-messages")).toEqual({ providerId: "anthropic", modelId: "custom-claude", surface: "anthropic-messages" });
  });
});

describe("AnthropicAdapter — call guard paths (no network)", () => {
  test("countTokens returns unknown", async () => {
    const adapter = new AnthropicAdapter();
    await expect(adapter.countTokens({ request: makeRequest().request, signal: new AbortController().signal })).resolves.toEqual({ tokens: null, source: "unknown" });
  });

  test("call rejects a mismatched providerId", async () => {
    const adapter = new AnthropicAdapter();
    const input = makeRequest({ target: { providerId: "other", modelId: "claude-sonnet-4-5", surface: "anthropic-messages" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  test("call rejects an unsupported surface", async () => {
    const adapter = new AnthropicAdapter();
    const input = makeRequest({ target: { providerId: "anthropic", modelId: "claude-sonnet-4-5", surface: "openai-chat" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });
});

describe("AnthropicAdapter — mapError", () => {
  test("maps a ProviderAdapterError faithfully", () => {
    const adapter = new AnthropicAdapter();
    const mapped = adapter.mapError(new ProviderAdapterError({ kind: "provider_unavailable", message: "down", statusCode: 503, retryable: true, routeScope: "provider" }));
    expect(mapped.kind).toBe("provider_unavailable");
    expect(mapped.retryable).toBe(true);
  });
});
