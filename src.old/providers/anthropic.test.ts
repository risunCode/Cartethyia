import { describe, expect, test } from "bun:test";
import type { ProxyRequest } from "../application/contracts";
import { resolveModelWireSurface } from "../open-sse/translate";
import { AnthropicAdapter } from "./anthropic";

const limits = { maxBodyBytes: 1_000_000, connectTimeoutMs: 10_000, firstByteTimeoutMs: 30_000, idleTimeoutMs: 30_000, totalTimeoutMs: 120_000 };

function request(): ProxyRequest {
  return {
    model: "claude-opus-4-1",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "anthropic-messages",
    signal: new AbortController().signal,
    limits,
  };
}

describe("Anthropic model surface routing", () => {
  test("translates OpenAI client surfaces onto the Anthropic Messages wire", () => {
    const adapter = new AnthropicAdapter();
    const model = adapter.models.get("claude-opus-4-1");

    expect(resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, "openai-chat")).toBe("anthropic-messages");
    expect(resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, "openai-responses")).toBe("anthropic-messages");
    expect(resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, "anthropic-messages")).toBe("anthropic-messages");
  });
});
describe("Anthropic gateway headers", () => {
  test("owns upstream headers without forwarding client credentials or client identity", async () => {
    const originalFetch = globalThis.fetch;
    let sentHeaders: Headers | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ id: "msg_1", type: "message", content: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const adapter = new AnthropicAdapter({ baseUrl: "https://gateway.test/v1" });
      const result = await adapter.call({
        target: adapter.resolveTarget("claude-opus-4-1", "anthropic-messages"),
        request: request(),
        credential: "upstream-secret",
        network: { proxyId: null, url: null, release: async () => {} },
        signal: new AbortController().signal,
        headers: new Headers({
          "x-app": "claude-code",
          "x-client-request-id": "request-123",
          "anthropic-version": "client-version",
          "anthropic-beta": "client-beta",
          "x-claude-code-session": "client-session",
          "user-agent": "claude-cli/client",
          authorization: "Bearer client-secret",
          "x-api-key": "client-secret",
          "x-unrelated-header": "discard-me",
        }),
      });
      expect(result.mode).toBe("non_stream");
      expect(sentHeaders?.get("x-app")).toBe(null);
      expect(sentHeaders?.get("x-client-request-id")).toBe(null);
      expect(sentHeaders?.get("authorization")).toBe(null);
      expect(sentHeaders?.get("x-api-key")).toBe("upstream-secret");
      expect(sentHeaders?.get("x-unrelated-header")).toBe(null);
      expect(sentHeaders?.get("anthropic-version")).toBe("2023-06-01");
      expect(sentHeaders?.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");
      expect(sentHeaders?.get("x-claude-code-session")).toBe(null);
      expect(sentHeaders?.get("user-agent")).toBe(null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
