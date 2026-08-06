import { describe, expect, test } from "bun:test";
import { buildGeminiPayload } from "../../src/domain/protocols/gemini-generate-content";
import { GeminiAdapter } from "../../src/providers/gemini";
import { ProviderAdapterError } from "../../src/providers/shared";
import type { ProviderRequest } from "../../src/domain/contracts";

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: { providerId: "gemini", modelId: "gemini-2.5-pro", upstreamModelId: "gemini-2.5-pro", surface: "openai-chat" },
    request: {
      model: "gemini-2.5-pro",
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
    credential: "AIza-test",
    network: { select: async () => ({ proxyId: null, selection: { proxyId: null, url: null, release: async () => {} } }) } as never,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("GeminiAdapter — identity & catalog", () => {
  test("declares the gemini protocol and api_key credential kind", () => {
    const adapter = new GeminiAdapter();
    expect(adapter.metadata).toMatchObject({ id: "gemini", displayName: "Google Gemini", protocol: "gemini", credentialKind: "api_key" });
  });

  test("supports cross-protocol chat and image surfaces", () => {
    const adapter = new GeminiAdapter();
    expect(adapter.capabilities.surfaces).toContain("openai-chat");
    expect(adapter.capabilities.surfaces).toContain("openai-responses");
    expect(adapter.capabilities.surfaces).toContain("anthropic-messages");
    expect(adapter.capabilities.surfaces).toContain("images");
  });

  test("honors config overrides", () => {
    const adapter = new GeminiAdapter({ id: "gemini-cn", displayName: "Gemini CN", baseUrl: "https://gemini.cn/v1beta//" });
    expect(adapter.metadata.id).toBe("gemini-cn");
    expect(adapter.metadata.displayName).toBe("Gemini CN");
  });

  test("exposes the default catalog with reasoning/image models", () => {
    const adapter = new GeminiAdapter();
    expect(adapter.models.get("gemini-2.5-pro")?.capabilities.reasoning).toBe(true);
    expect(adapter.models.get("gemini-2.0-flash")?.capabilities.images).toBe(true);
    expect(adapter.models.get("nope")).toBe(null);
  });
});

describe("GeminiAdapter — resolveTarget", () => {
  test("resolves a known model on a supported cross-protocol surface", () => {
    const adapter = new GeminiAdapter();
    expect(adapter.resolveTarget("gemini-2.5-flash", "anthropic-messages")).toEqual({ providerId: "gemini", modelId: "gemini-2.5-flash", upstreamModelId: "gemini-2.5-flash", surface: "anthropic-messages" });
  });

  test("resolves a Gemini image model on the image surface", () => {
    const adapter = new GeminiAdapter();
    expect(adapter.resolveTarget("gemini-3.1-flash-image-preview", "images")).toEqual({ providerId: "gemini", modelId: "gemini-3.1-flash-image-preview", upstreamModelId: "gemini-3.1-flash-image-preview", surface: "images" });
  });

  test("rejects an unknown model", () => {
    const adapter = new GeminiAdapter();
    try {
      adapter.resolveTarget("no-such-gemini", "openai-chat");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ProviderAdapterError).kind).toBe("model_not_found");
    }
  });

  test("accepts any model with an empty catalog", () => {
    const adapter = new GeminiAdapter({ models: [] });
    expect(adapter.resolveTarget("custom-gem", "openai-chat")).toEqual({ providerId: "gemini", modelId: "custom-gem", upstreamModelId: "custom-gem", surface: "openai-chat" });
  });
});

describe("Gemini image payload", () => {
  test("requests text and image response modalities", () => {
    const payload = buildGeminiPayload({ ...makeRequest().request, sourceSurface: "images" });
    expect(payload.generationConfig).toMatchObject({ responseModalities: ["TEXT", "IMAGE"] });
  });
});

describe("GeminiAdapter — call guard paths (no network)", () => {
  test("countTokens returns unknown", async () => {
    const adapter = new GeminiAdapter();
    await expect(adapter.countTokens({ request: makeRequest().request, signal: new AbortController().signal })).resolves.toEqual({ tokens: null, source: "unknown" });
  });

  test("call rejects a mismatched providerId", async () => {
    const adapter = new GeminiAdapter();
    const input = makeRequest({ target: { providerId: "other", modelId: "gemini-2.5-pro", upstreamModelId: "gemini-2.5-pro", surface: "openai-chat" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  test("call rejects an unsupported surface", async () => {
    const adapter = new GeminiAdapter();
    const input = makeRequest({ target: { providerId: "gemini", modelId: "gemini-2.5-pro", upstreamModelId: "gemini-2.5-pro", surface: "images" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });
});

describe("GeminiAdapter — mapError", () => {
  test("maps a ProviderAdapterError faithfully", () => {
    const adapter = new GeminiAdapter();
    const mapped = adapter.mapError(new ProviderAdapterError({ kind: "provider_protocol_error", message: "bad gemini", statusCode: 502, routeScope: "provider" }));
    expect(mapped.kind).toBe("provider_protocol_error");
    expect(mapped.retryable).toBe(false);
  });
});
