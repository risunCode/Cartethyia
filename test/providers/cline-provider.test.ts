import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderRequest } from "../../src/application/contracts";
import { ClineAdapter } from "../../src/providers/cline";

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
      limits: {
        maxBodyBytes: 1_000_000,
        connectTimeoutMs: 5_000,
        firstByteTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        totalTimeoutMs: 60_000,
      },
    },
    credential: "cline-access-token",
    network: { proxyId: null, url: null, release: async () => {} },
    signal: new AbortController().signal,
    headers: new Headers(),
  };
}

describe("Cline manual model routing", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("accepts and forwards a manually added model id verbatim", async () => {
    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const adapter = new ClineAdapter();
    const modelId = "nvidia/nemotron-3.5-lightning";
    const target = adapter.resolveTarget(modelId, "openai-chat");
    const output = await adapter.call(requestFor(target));

    expect(target).toMatchObject({
      providerId: "cline",
      modelId,
      upstreamModelId: modelId,
    });
    expect(output.mode).toBe("non_stream");
    expect(payload?.model).toBe(modelId);
  });
});
