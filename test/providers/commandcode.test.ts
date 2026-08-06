import { describe, expect, test } from "bun:test";
import { CommandCodeAdapter } from "../../src/providers/commandcode";
import { ProviderAdapterError } from "../../src/providers/shared";
import type { ProviderRequest } from "../../src/domain/contracts";

function makeRequest(credential: string, overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: { providerId: "commandcode", modelId: "moonshotai/Kimi-K2.6", upstreamModelId: "moonshotai/Kimi-K2.6", surface: "openai-chat" },
    request: {
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      stream: true,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: null,
      images: [],
      sourceSurface: "openai-chat",
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 },
    },
    credential,
    network: { select: async () => ({ proxyId: null, selection: { proxyId: null, url: null, release: async () => {} } }) } as never,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("CommandCodeAdapter — identity & catalog", () => {
  test("declares the anthropic protocol and api_key credential kind", () => {
    const adapter = new CommandCodeAdapter();
    expect(adapter.metadata).toMatchObject({ id: "commandcode", displayName: "Command Code", protocol: "anthropic", credentialKind: "api_key" });
  });

  test("supports only the openai-chat surface with streaming", () => {
    const adapter = new CommandCodeAdapter();
    expect(adapter.capabilities.surfaces).toEqual(["openai-chat"]);
    expect(adapter.capabilities.streaming).toBe(true);
    expect(adapter.capabilities.reasoning).toBe(true);
  });

  test("exposes the default model catalog", () => {
    const adapter = new CommandCodeAdapter();
    expect(adapter.models.get("moonshotai/Kimi-K2.6")?.displayName).toBe("Kimi K2.6");
    expect(adapter.models.get("deepseek/deepseek-v4-pro")?.capabilities.reasoning).toBe(true);
    expect(adapter.models.get("nope")).toBe(null);
  });
});

describe("CommandCodeAdapter — resolveTarget", () => {
  test("resolves a known model on the openai-chat surface", () => {
    const adapter = new CommandCodeAdapter();
    expect(adapter.resolveTarget("qwen/qwen3.5-plus", "openai-chat")).toEqual({ providerId: "commandcode", modelId: "qwen/qwen3.5-plus", upstreamModelId: "qwen/qwen3.5-plus", surface: "openai-chat" });
  });

  test("accepts an unknown model (Command Code does not gate on its catalog)", () => {
    const adapter = new CommandCodeAdapter();
    // resolveTarget only checks the surface, not the model id.
    expect(adapter.resolveTarget("any/model", "openai-chat")).toEqual({ providerId: "commandcode", modelId: "any/model", upstreamModelId: "any/model", surface: "openai-chat" });
  });

  test("rejects an unsupported surface", () => {
    const adapter = new CommandCodeAdapter();
    expect(() => adapter.resolveTarget("moonshotai/Kimi-K2.6", "anthropic-messages")).toThrow(ProviderAdapterError);
    try {
      adapter.resolveTarget("moonshotai/Kimi-K2.6", "images");
    } catch (error) {
      expect((error as ProviderAdapterError).kind).toBe("capability_unsupported");
    }
  });
});

describe("CommandCodeAdapter — call guard paths (no network)", () => {
  test("countTokens returns unknown", async () => {
    const adapter = new CommandCodeAdapter();
    await expect(adapter.countTokens({ request: makeRequest("x").request, signal: new AbortController().signal })).resolves.toEqual({ tokens: null, source: "unknown" });
  });

  test("call rejects an unsupported surface before the network", async () => {
    const adapter = new CommandCodeAdapter();
    const input = makeRequest("user_tok", { target: { providerId: "commandcode", modelId: "moonshotai/Kimi-K2.6", upstreamModelId: "moonshotai/Kimi-K2.6", surface: "anthropic-messages" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  test("call rejects an empty credential with authentication_failed", async () => {
    const adapter = new CommandCodeAdapter();
    const input = makeRequest("", { target: { providerId: "commandcode", modelId: "moonshotai/Kimi-K2.6", upstreamModelId: "moonshotai/Kimi-K2.6", surface: "openai-chat" } });
    try {
      await adapter.call(input);
      throw new Error("should have thrown");
    } catch (error) {
      const typed = error as ProviderAdapterError;
      expect(typed.kind).toBe("authentication_failed");
      expect(typed.routeScope).toBe("account");
    }
  });
});

describe("CommandCodeAdapter — mapError", () => {
  test("maps a ProviderAdapterError faithfully", () => {
    const adapter = new CommandCodeAdapter();
    const mapped = adapter.mapError(new ProviderAdapterError({ kind: "provider_rate_limited", message: "slow", statusCode: 429, retryable: true, routeScope: "provider" }));
    expect(mapped.kind).toBe("provider_rate_limited");
    expect(mapped.retryable).toBe(true);
  });
});
