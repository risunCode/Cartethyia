import { describe, expect, test } from "bun:test";
import { CloudflareAdapter } from "../../src/providers/cloudflare";
import { ProviderAdapterError } from "../../src/providers/shared";

describe("CloudflareAdapter", () => {
  const adapter = new CloudflareAdapter();

  test("exposes the Workers AI OpenAI-compatible contract", () => {
    expect(adapter.metadata.id).toBe("cloudflare");
    expect(adapter.metadata.credentialKind).toBe("api_key");
    expect(adapter.resolveTarget("@cf/meta/llama-3.1-8b-instruct", "openai-chat")).toEqual({
      providerId: "cloudflare",
      modelId: "@cf/meta/llama-3.1-8b-instruct",
      surface: "openai-chat",
    });
  });

  test("exposes bounded token-count and error mapping hooks", async () => {
    const stats = await adapter.countTokens({} as never);
    expect(stats).toEqual({ tokens: null, source: "unknown" });
    const mapped = adapter.mapError(new Error("upstream unavailable"));
    expect(mapped.kind).toBe("provider_protocol_error");
  });

  test("rejects unsupported surfaces", () => {
    expect(() => adapter.resolveTarget("model", "images")).toThrow(ProviderAdapterError);
  });

  test("rejects credentials without a valid account id before network dispatch", async () => {
    await expect(adapter.call({
      target: { providerId: "cloudflare", modelId: "@cf/meta/llama-3.1-8b-instruct", surface: "openai-chat" },
      request: {
        sourceSurface: "openai-chat",
        model: "@cf/meta/llama-3.1-8b-instruct",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        stream: false,
        tools: [],
        toolChoice: null,
        responseFormat: null,
        maxTokens: null,
        temperature: null,
        topP: null,
        stop: null,
        reasoning: null,
        metadata: {},
        limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, totalTimeoutMs: 2_000, idleTimeoutMs: 1_000 },
      },
      credential: JSON.stringify({ apiKey: "token" }),
      network: { url: null, isRelay: false },
      signal: new AbortController().signal,
    } as never)).rejects.toBeInstanceOf(ProviderAdapterError);
  });
});
