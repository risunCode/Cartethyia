import { describe, expect, test } from "bun:test";
import { normalizeRequest } from "../../src/domain/protocols";
import { callHostedImageWire } from "../../src/transport/protocols/openai";
import type { NetworkSelection, ProviderRequest } from "../../src/domain/contracts";

const limits = { maxBodyBytes: 2_000_000, connectTimeoutMs: 100, firstByteTimeoutMs: 100, idleTimeoutMs: 100, totalTimeoutMs: 1_000 } as const;
const network: NetworkSelection = { proxyId: null, url: null, release: async () => {} };

function request(body: unknown, endpoint: "/v1/images/generations" | "/v1/images/edits"): ProviderRequest {
  const normalized = normalizeRequest(endpoint, body, { signal: new AbortController().signal, limits });
  if (!normalized.ok) throw new Error(normalized.error.sanitizedMessage);
  return { target: { providerId: "openai", modelId: normalized.request.model, surface: "images" }, request: normalized.request, credential: "test-key", network, signal: normalized.request.signal };
}

describe("OpenAI hosted image transport", () => {
  test("sends the hosted image tool and returns Images API data", async () => {
    const original = globalThis.fetch;
    const payload: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      Object.assign(payload, JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ output: [{ type: "image_generation_call", result: "aW1hZ2U=", revised_prompt: "revised" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const result = await callHostedImageWire(request({ model: "gpt-5", prompt: "A moon" }, "/v1/images/generations"), "https://api.openai.test/v1/responses", { authorization: "Bearer test-key", "content-type": "application/json" });
      expect(result.mode).toBe("non_stream");
      if (result.mode !== "non_stream") return;
      expect(result.body).toEqual({ created: expect.any(Number), data: [{ b64_json: "aW1hZ2U=", revised_prompt: "revised" }] });
      expect(payload?.tools).toEqual([{ type: "image_generation", action: "generate", output_format: "webp" }]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("sends input images and edit action", async () => {
    const original = globalThis.fetch;
    const payload: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      Object.assign(payload, JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ output: [{ type: "image_generation_call", result: "aW1hZ2U=" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await callHostedImageWire(request({ model: "gpt-5", prompt: "Add a moon", images: ["data:image/png;base64,AAAA"] }, "/v1/images/edits"), "https://api.openai.test/v1/responses", { authorization: "Bearer test-key", "content-type": "application/json" });
      expect(payload?.tools).toEqual([{ type: "image_generation", action: "edit", output_format: "webp" }]);
      expect(payload?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Add a moon" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] }]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
