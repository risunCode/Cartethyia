import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderRequest } from "../../src/application/contracts";
import { resolveModelWireSurface } from "../../src/open-sse/translate";
import { buildCodexImagePayload, CodexAdapter } from "../../src/providers/codex";

const originalFetch = globalThis.fetch;

function imageRequest(target: ProviderRequest["target"], credential: string): ProviderRequest {
  return {
    target,
    request: {
      model: target.modelId,
      messages: [{ role: "user", content: [{ type: "text", text: "a red apple" }] }],
      tools: [],
      stream: false,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: null,
      images: [],
      imageOperation: "generate",
      sourceSurface: "images",
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 5_000, firstByteTimeoutMs: 10_000, idleTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
    },
    credential,
    network: { proxyId: null, url: null, release: async () => {} },
    signal: new AbortController().signal,
    headers: new Headers(),
  };
}

function codexCredential(): string {
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  return `${encode("header")}.${encode(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }))}.${encode("signature")}`;
}

describe("Codex provider", () => {
  test("uses the Responses wire surface for chat and Responses clients", () => {
    const adapter = new CodexAdapter();
    const model = adapter.models.get("gpt-5.6-luna");

    expect(model).not.toBeNull();
    expect(resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, "openai-chat")).toBe("openai-responses");
    expect(resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, "openai-responses")).toBe("openai-responses");
  });

  test("resolves Luna against the Responses adapter contract", () => {
    const adapter = new CodexAdapter();

    expect(adapter.resolveTarget("gpt-5.6-luna", "openai-responses")).toEqual({
      providerId: "codex",
      modelId: "gpt-5.6-luna",
      upstreamModelId: "gpt-5.6-luna",
      surface: "openai-responses",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses the base model id and Codex CLI image contract", async () => {
    const adapter = new CodexAdapter();
    const target = adapter.resolveTarget("gpt-5.4-image", "images");
    const input = imageRequest(target, codexCredential());
    const payload = buildCodexImagePayload(input.request, target.upstreamModelId);

    expect(payload.model).toBe("gpt-5.4");
    expect(payload.stream).toBe(true);
    expect(payload.tool_choice).toBe("auto");
    expect(payload.tools).toEqual([{ type: "image_generation", output_format: "png" }]);

    const captured: { url: string; body: Record<string, unknown> | null; headers: Headers | null } = { url: "", body: null, headers: null };
    globalThis.fetch = (async (inputUrl, init) => {
      captured.url = String(inputUrl);
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      captured.headers = new Headers(init?.headers);
      return new Response(
        "event: response.output_item.done\ndata: {\"item\":{\"type\":\"image_generation_call\",\"result\":\"AAAA\"}}\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const output = await adapter.call(input);

    expect(captured.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(captured.body?.model).toBe("gpt-5.4");
    expect(captured.body?.stream).toBe(true);
    expect(captured.headers?.get("originator")).toBe("codex_cli_rs");
    expect(captured.headers?.get("session_id")).not.toBeNull();
    expect(output).toMatchObject({ mode: "non_stream", body: { data: [{ b64_json: "AAAA" }] } });
  });
});
