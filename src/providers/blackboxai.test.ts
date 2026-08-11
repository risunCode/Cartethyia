import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderRequest } from "../application/contracts";
import { resolveModelWireSurface } from "../open-sse/translate";
import { BlackboxAIAdapter, blackboxaiConfig } from "./blackboxai";

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
    credential: "blackbox-test-key",
    network: { proxyId: null, url: null, release: async () => {} },
    signal: new AbortController().signal,
  };
}

describe("Blackbox GLM surface routing", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("catalogs and routes only the requested GLM models", () => {
    expect(blackboxaiConfig.models.map((model) => model.id)).toEqual(["z-ai/glm-5.2", "z-ai/glm-5.2-vercel"]);
    const glm = blackboxaiConfig.models.find((model) => model.id === "z-ai/glm-5.2");
    const glmVercel = blackboxaiConfig.models.find((model) => model.id === "z-ai/glm-5.2-vercel");
    expect(glm?.capabilities.surfaces).toEqual(["openai-chat"]);
    expect(glmVercel?.capabilities.surfaces).toEqual(["openai-chat"]);
    expect(BlackboxAIAdapter.resolveTarget("z-ai/glm-5.2", "openai-chat")).toMatchObject({
      providerId: "blackboxai",
      modelId: "z-ai/glm-5.2",
      upstreamModelId: "blackboxai/z-ai/glm-5.2",
      surface: "openai-chat",
    });
    expect(() => BlackboxAIAdapter.resolveTarget("z-ai/glm-5.2", "anthropic-messages")).toThrow(/does not support surface/);
  });

  test("uses model capabilities when resolving a client surface", () => {
    const glm = BlackboxAIAdapter.models.get("z-ai/glm-5.2");
    expect(glm).not.toBeNull();
    expect(resolveModelWireSurface(BlackboxAIAdapter.metadata, BlackboxAIAdapter.capabilities, glm?.capabilities ?? null, "openai-chat")).toBe("openai-chat");
    expect(resolveModelWireSurface(BlackboxAIAdapter.metadata, BlackboxAIAdapter.capabilities, glm?.capabilities ?? null, "anthropic-messages")).toBe("openai-chat");
  });

  test("sends GLM through the Chat Completions endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init: init ?? {} });
      return new Response(JSON.stringify({ id: "chatcmpl_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const target = BlackboxAIAdapter.resolveTarget("z-ai/glm-5.2", "openai-chat");
    const output = await BlackboxAIAdapter.call(requestFor(target));
    const call = calls[0];
    const headers = new Headers(call?.init.headers);
    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;

    expect(output.mode).toBe("non_stream");
    expect(call?.url).toBe("https://api.blackbox.ai/v1/chat/completions");
    expect(headers.get("authorization")).toBe("Bearer blackbox-test-key");
    expect(headers.get("anthropic-version")).toBeNull();
    expect(body).toMatchObject({ model: "blackboxai/z-ai/glm-5.2", max_tokens: 128 });
  });
});
