import { afterEach, describe, expect, test } from "bun:test";
import { OpenAIAdapter } from "../../src/providers/openai";
import type { ProviderRequest } from "../../src/application/contracts";

const originalFetch = globalThis.fetch;
const limits = { maxBodyBytes: 1_000_000, connectTimeoutMs: 5_000, firstByteTimeoutMs: 10_000, idleTimeoutMs: 10_000, totalTimeoutMs: 30_000 } as const;

function request(stream: boolean, signal = new AbortController().signal): ProviderRequest {
  return {
    target: { providerId: "openai", modelId: "gpt-5", upstreamModelId: "gpt-5", surface: "openai-responses" },
    request: {
      model: "gpt-5", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [], stream,
      responseFormat: "text", reasoning: "default", maxOutputTokens: 64, images: [], sourceSurface: "openai-responses",
      signal, limits,
    },
    credential: "fixture-key", network: { proxyId: null, url: null, release: async () => {} }, signal, headers: new Headers({ "x-client-name": "codex", authorization: "Bearer client-secret" }),
  };
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe("adapter transport integration", () => {
  test("sends Responses JSON to the configured URL with provider-owned auth", async () => {
    const captured: { url: string; init: RequestInit | undefined } = { url: "", init: undefined };
    globalThis.fetch = (async (url, init) => {
      captured.url = String(url);
      captured.init = init;
      return new Response(JSON.stringify({ id: "resp_1", object: "response", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const output = await new OpenAIAdapter({ baseUrl: "https://upstream.test/v1" }).call(request(false));
    expect(output.mode).toBe("non_stream");
    expect(captured.url).toBe("https://upstream.test/v1/responses");
    expect(JSON.parse(String(captured.init?.body))).toMatchObject({ model: "gpt-5", input: [{ role: "user", content: "hello" }] });
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-key");
    expect(headers.get("x-client-name")).toBeNull();
  });
  test("retries once without unsupported explicit cache options", async () => {
    const calls: Record<string, unknown>[] = [];
    let attempt = 0;
    globalThis.fetch = (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      attempt += 1;
      if (attempt === 1) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: prompt_cache_options" } }), { status: 400, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ id: "resp_retry", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const base = request(false);
    const output = await new OpenAIAdapter({ baseUrl: "https://upstream.test/v1" }).call({
      ...base,
      target: { ...base.target, modelId: "gpt-5.6", upstreamModelId: "gpt-5.6" },
      request: {
        ...base.request,
        model: "gpt-5.6",
        sourceSurface: "anthropic-messages",
        cacheKey: "fixture-cache",
        messages: [{ role: "system", content: [{ type: "text", text: "stable instructions", cacheControl: "ephemeral" }] }],
      },
    });
    expect(output.mode).toBe("non_stream");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt_cache_options).toBeDefined();
    expect(calls[1]?.prompt_cache_options).toBeUndefined();
    expect(calls[1]?.prompt_cache_key).toBe("fixture-cache");
  });

  test("does not retry or remove semantic input on an unsafe parameter rejection", async () => {
    let calls = 0;
    globalThis.fetch = (async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("gpt-5");
      expect(body.input).toEqual([{ role: "user", content: "hello" }]);
      return new Response(JSON.stringify({ error: { message: "Unsupported parameter: input" } }), { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await expect(new OpenAIAdapter({ baseUrl: "https://upstream.test/v1" }).call(request(false))).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  test("maps upstream SSE and preserves abort ownership", async () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init: RequestInit | undefined) => new Response(
      "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_2\"}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_2\",\"status\":\"completed\"}}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
    const output = await new OpenAIAdapter({ baseUrl: "https://upstream.test/v1" }).call(request(true));
    expect(output.mode).toBe("stream");
    if (output.mode !== "stream") return;
    const events: string[] = [];
    for await (const event of output.events) if (event.type === "text_delta") events.push(event.text);
    expect(events).toEqual(["hello"]);
  });

  test("classifies an already-aborted request as client cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    let passedSignal = false;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => { passedSignal = init?.signal instanceof AbortSignal ? init.signal.aborted : false; throw new DOMException("Aborted", "AbortError"); }) as unknown as typeof fetch;
    await expect(new OpenAIAdapter().call(request(false, controller.signal))).rejects.toBeDefined();
    expect(passedSignal).toBe(true);
  });
});
