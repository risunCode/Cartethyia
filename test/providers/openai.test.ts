import { describe, expect, test } from "bun:test";
import { OpenAIAdapter } from "../../src/providers/openai";
import { ProviderAdapterError } from "../../src/providers/shared";
import type { ProviderRequest } from "../../src/domain/contracts";

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: { providerId: "openai", modelId: "gpt-4o", surface: "openai-chat" },
    request: {
      model: "gpt-4o",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      stream: false,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: null,
      images: [],
      sourceSurface: "openai-chat",
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 },
    },
    credential: "sk-test",
    network: { select: async () => ({ proxyId: null, selection: { proxyId: null, url: null, release: async () => {} } }) } as never,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("OpenAIAdapter — identity & catalog", () => {
  test("declares the openai protocol and api_key credential kind by default", () => {
    const adapter = new OpenAIAdapter();
    expect(adapter.metadata).toMatchObject({ id: "openai", displayName: "OpenAI", protocol: "openai", credentialKind: "api_key" });
  });

  test("honors config overrides for id, displayName, baseUrl, and credentialKind", () => {
    const adapter = new OpenAIAdapter({ id: "openai-cn", displayName: "OpenAI China", baseUrl: "https://api.openai.cn/v1//", credentialKind: "manual" });
    expect(adapter.metadata.id).toBe("openai-cn");
    expect(adapter.metadata.displayName).toBe("OpenAI China");
    expect(adapter.metadata.credentialKind).toBe("manual");
  });

  test("exposes the default model catalog with reasoning/image-capable models", () => {
    const adapter = new OpenAIAdapter();
    expect(adapter.models.get("gpt-5")?.displayName).toBe("GPT-5");
    expect(adapter.models.get("gpt-4o")?.capabilities.images).toBe(true);
    expect(adapter.models.get("o3")?.capabilities.reasoning).toBe(true);
    expect(adapter.models.get("does-not-exist")).toBe(null);
  });

  test("aggregates capabilities across the catalog (chat + responses + images)", () => {
    const adapter = new OpenAIAdapter();
    expect(adapter.capabilities.surfaces).toContain("openai-chat");
    expect(adapter.capabilities.surfaces).toContain("openai-responses");
    expect(adapter.capabilities.surfaces).toContain("images");
    expect(adapter.capabilities.streaming).toBe(true);
  });
});

describe("OpenAIAdapter — resolveTarget", () => {
  test("resolves a known model on a supported surface", () => {
    const adapter = new OpenAIAdapter();
    expect(adapter.resolveTarget("gpt-4o", "openai-chat")).toEqual({ providerId: "openai", modelId: "gpt-4o", surface: "openai-chat" });
  });

  test("rejects an unsupported surface with capability_unsupported (400)", () => {
    const adapter = new OpenAIAdapter();
    expect(() => adapter.resolveTarget("gpt-4o", "anthropic-messages")).toThrow(ProviderAdapterError);
    try {
      adapter.resolveTarget("gpt-4o", "anthropic-messages");
    } catch (error) {
      const typed = error as ProviderAdapterError;
      expect(typed.kind).toBe("capability_unsupported");
      expect(typed.statusCode).toBe(400);
    }
  });

  test("rejects an unknown model with model_not_found (404)", () => {
    const adapter = new OpenAIAdapter();
    expect(() => adapter.resolveTarget("no-such-model", "openai-chat")).toThrow(ProviderAdapterError);
    try {
      adapter.resolveTarget("no-such-model", "openai-chat");
    } catch (error) {
      const typed = error as ProviderAdapterError;
      expect(typed.kind).toBe("model_not_found");
      expect(typed.statusCode).toBe(404);
    }
  });

  test("accepts any model when the catalog is empty (custom-provider case)", () => {
    const adapter = new OpenAIAdapter({ models: [] });
    expect(adapter.resolveTarget("any-model", "openai-chat")).toEqual({ providerId: "openai", modelId: "any-model", surface: "openai-chat" });
  });
});

describe("OpenAIAdapter — call guard paths (no network)", () => {
  test("countTokens returns unknown without contacting a tokenizer", async () => {
    const adapter = new OpenAIAdapter();
    await expect(adapter.countTokens({ request: makeRequest().request, signal: new AbortController().signal })).resolves.toEqual({ tokens: null, source: "unknown" });
  });

  test("call rejects a request whose providerId does not match the adapter id", async () => {
    const adapter = new OpenAIAdapter();
    const input = makeRequest({ target: { providerId: "other", modelId: "gpt-4o", surface: "openai-chat" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  test("call rejects an unsupported surface", async () => {
    const adapter = new OpenAIAdapter();
    const input = makeRequest({ target: { providerId: "openai", modelId: "gpt-4o", surface: "anthropic-messages" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });
});

describe("OpenAIAdapter — mapError", () => {
  test("maps a ProviderAdapterError to a typed ProviderCallError", () => {
    const adapter = new OpenAIAdapter();
    const mapped = adapter.mapError(new ProviderAdapterError({ kind: "provider_rate_limited", message: "slow down", statusCode: 429, retryable: true, routeScope: "provider" }));
    expect(mapped.kind).toBe("provider_rate_limited");
    expect(mapped.retryable).toBe(true);
    expect(mapped.statusCode).toBe(429);
  });

  test("maps a plain Error to a provider_protocol_error with a sanitized message", () => {
    const adapter = new OpenAIAdapter();
    const mapped = adapter.mapError(new Error("boom"));
    expect(mapped.kind).toBe("provider_protocol_error");
    expect(mapped.retryable).toBe(false);
    expect(mapped.sanitizedMessage).toContain("boom");
  });
});
