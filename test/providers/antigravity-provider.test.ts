import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderRequest } from "../../src/application/contracts";
import { buildAntigravityImagePayload, AntigravityAdapter, antigravityWireModelId } from "../../src/providers/antigravity";

const originalFetch = globalThis.fetch;

function requestFor(target: ProviderRequest["target"], credential: string, sourceSurface: "images" | "openai-chat", headers = new Headers()): ProviderRequest {
  return {
    target,
    request: {
      model: target.modelId,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      stream: false,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: null,
      images: [],
      ...(sourceSurface === "images" ? { imageOperation: "generate" as const } : {}),
      sourceSurface,
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 5_000, firstByteTimeoutMs: 10_000, idleTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
    },
    credential,
    network: { proxyId: null, url: null, release: async () => {} },
    signal: new AbortController().signal,
    headers,
  };
}

function imageRequest(target: ProviderRequest["target"], credential: string): ProviderRequest {
  return requestFor(target, credential, "images");
}

function chatRequest(target: ProviderRequest["target"], credential: string, conversationId: string): ProviderRequest {
  return requestFor(target, credential, "openai-chat", new Headers({ "x-conversation-id": conversationId }));
}

function antigravityCredential(): string {
  return JSON.stringify({ accessToken: "access-token", projectId: "project-1" });
}

function antigravityTextResponse(responseId: string): Response {
  return new Response(`data: ${JSON.stringify({
    response: {
      responseId,
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    },
  })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Antigravity model catalog", () => {
  test("deduplicates display models while preserving upstream aliases", () => {
    const adapter = new AntigravityAdapter();

    expect(adapter.models.list.map((model) => model.id)).toEqual([
      "gemini-3.1-pro",
      "gemini-3.5-flash",
      "gemini-3-flash",
      "claude-sonnet-4-6",
      "gpt-oss-120b",
      "gemini-3.1-flash-image",
    ]);
    expect(adapter.resolveTarget("gemini-3.1-pro", "openai-chat").upstreamModelId).toBe("gemini-pro-agent");
    expect(adapter.resolveTarget("gpt-oss-120b", "openai-chat").upstreamModelId).toBe("gpt-oss-120b-medium");
  });

  test("routes the image generation model only to the image surface", () => {
    const adapter = new AntigravityAdapter();

    expect(adapter.resolveTarget("gemini-3.1-flash-image", "images").upstreamModelId).toBe("gemini-3.1-flash-image");
    expect(() => adapter.resolveTarget("gemini-3.1-flash-image", "openai-chat")).toThrow("does not support surface");
  });

  test("keeps wire aliases compatible with direct logical model requests", () => {
    expect(antigravityWireModelId("gemini-3.1-pro")).toBe("gemini-pro-agent");
    expect(antigravityWireModelId("gemini-3.5-flash")).toBe("gemini-3.5-flash-extra-low");
    expect(antigravityWireModelId("gpt-oss-120b")).toBe("gpt-oss-120b-medium");
  });
  test("uses Antigravity's native non-stream image-generation contract", async () => {
    const adapter = new AntigravityAdapter();
    const target = adapter.resolveTarget("gemini-3.1-flash-image", "images");
    const input = imageRequest(target, antigravityCredential());
    const payload = buildAntigravityImagePayload(input.request, { accessToken: "access-token", projectId: "project-1" }, target.upstreamModelId);

    expect(payload.model).toBe("gemini-3.1-flash-image");
    expect(payload.requestType).toBe("image_gen");
    expect((payload.request as Record<string, unknown>).generationConfig).toMatchObject({
      temperature: 1,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192,
      imageConfig: { aspectRatio: "1:1" },
    });

    const captured: { url: string; body: Record<string, unknown> | null; headers: Headers | null } = { url: "", body: null, headers: null };
    globalThis.fetch = (async (inputUrl, init) => {
      captured.url = String(inputUrl);
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      captured.headers = new Headers(init?.headers);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const output = await adapter.call(input);

    expect(captured.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(captured.body?.requestType).toBe("image_gen");
    expect(captured.headers?.get("user-agent")).toBe("antigravity/ide/2.1.1 darwin/arm64");
    expect(output).toMatchObject({ mode: "non_stream", body: { data: [{ b64_json: "AAAA", mime_type: "image/png" }] } });
  });

  test("keeps bounded route state affinity while isolating model switches", async () => {
    const adapter = new AntigravityAdapter({ sessionStateMaxEntries: 2, sessionStateIdleTtlMs: 60_000 });
    const captured: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_inputUrl, init) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return antigravityTextResponse(`execution-${captured.length}`);
    }) as typeof fetch;

    const target = adapter.resolveTarget("gemini-3-flash", "openai-chat");
    await adapter.call(chatRequest(target, antigravityCredential(), "conversation-1"));
    await adapter.call(chatRequest(target, antigravityCredential(), "conversation-1"));

    const firstRequest = captured[0]?.request as Record<string, unknown>;
    const secondRequest = captured[1]?.request as Record<string, unknown>;
    const firstLabels = firstRequest.labels as Record<string, unknown>;
    const secondLabels = secondRequest.labels as Record<string, unknown>;
    expect(secondLabels.last_execution_id).toBe("execution-1");
    expect(secondLabels.trajectory_id).toBe(firstLabels.trajectory_id);
    expect(secondLabels.last_step_index).toBe("2");
    expect(secondRequest.sessionId).toBe(firstRequest.sessionId);
    expect(adapter.sessionStateSize()).toBe(1);
    expect(adapter.inspectSessionStates().every((entry) => !entry.key.includes("access-token") && !entry.key.includes("hello"))).toBe(true);

    const switchedTarget = adapter.resolveTarget("gpt-oss-120b", "openai-chat");
    await adapter.call(chatRequest(switchedTarget, antigravityCredential(), "conversation-1"));
    const switchedRequest = captured[2]?.request as Record<string, unknown>;
    const switchedLabels = switchedRequest.labels as Record<string, unknown>;
    expect(switchedLabels.last_execution_id).toBeUndefined();
    expect(adapter.sessionStateSize()).toBe(1);
    expect(adapter.resetSession("conversation-1")).toBe(1);
    expect(adapter.sessionStateSize()).toBe(0);
  });
  test("applies capacity and idle TTL limits to provider state", async () => {
    let now = 0;
    const adapter = new AntigravityAdapter({ sessionStateMaxEntries: 1, sessionStateIdleTtlMs: 100, now: () => now });
    const captured: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_inputUrl, init) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return antigravityTextResponse(`execution-${captured.length}`);
    }) as typeof fetch;

    const target = adapter.resolveTarget("gemini-3-flash", "openai-chat");
    await adapter.call(chatRequest(target, antigravityCredential(), "conversation-a"));
    now = 1;
    await adapter.call(chatRequest(target, antigravityCredential(), "conversation-b"));
    expect(adapter.sessionStateSize()).toBe(1);

    const secondRequest = captured[1]?.request as Record<string, unknown>;
    expect((secondRequest.labels as Record<string, unknown>).last_execution_id).toBeUndefined();
    now = 102;
    await adapter.call(chatRequest(target, antigravityCredential(), "conversation-b"));
    const expiredRequest = captured[2]?.request as Record<string, unknown>;
    expect((expiredRequest.labels as Record<string, unknown>).last_execution_id).toBeUndefined();
    expect(adapter.sessionStateSize()).toBe(1);
  });
});
