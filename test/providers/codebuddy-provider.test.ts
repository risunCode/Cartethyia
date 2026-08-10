import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderRequest } from "../../src/application/contracts";
import { CodeBuddyAdapter } from "../../src/providers/codebuddy";

const originalFetch = globalThis.fetch;

function requestFor(target: ProviderRequest["target"]): ProviderRequest {
  return {
    target,
    request: {
      model: target.modelId,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      stream: false,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: 128,
      images: [],
      sourceSurface: target.surface,
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 5_000, firstByteTimeoutMs: 10_000, idleTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
    },
    credential: "codebuddy-test-key",
    network: { proxyId: null, url: null, release: async () => {} },
    signal: new AbortController().signal,
    headers: new Headers({ "x-client-name": "pi" }),
  };
}

describe("CodeBuddy client identity isolation", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("does not forward the Cartethyia client tracking header upstream", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    globalThis.fetch = (async (_input, init) => {
      calls.push({ init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const adapter = new CodeBuddyAdapter();
    const target = adapter.resolveTarget("gpt-5.1", "openai-chat");
    const output = await adapter.call(requestFor(target));
    const headers = new Headers(calls[0]?.init.headers);

    expect(output.mode).toBe("non_stream");
    expect(headers.get("x-client-name")).toBeNull();
    expect(headers.get("x-product")).toBe("SaaS");
  });
});
