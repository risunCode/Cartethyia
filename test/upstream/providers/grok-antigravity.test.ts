import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { grokCliProvider } from "../../../src/upstream/providers/grok-cli";
import { googleAntigravityProvider } from "../../../src/upstream/providers/google-antigravity";
import { decodeGoogleGeminiStream } from "../../../src/upstream/providers/google-gemini-handler";
import { pollGrokDeviceAuthorization, requestGrokDeviceAuthorization } from "../../../src/tokenkeeper/oauth";

const signal = AbortSignal.timeout(1_000);

describe("Antigravity usage decoding", () => {
  test("captures root usage metadata including reasoning tokens", async () => {
    const payload = `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] }, usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, thoughtsTokenCount: 5 } })}\r\n\r\n`;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } });
    const events = [];
    for await (const event of decodeGoogleGeminiStream(stream)) events.push(event);
    expect(events).toContainEqual({ type: "usage", inputTokens: 12, outputTokens: 8, reasoningTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("Grok CLI provider", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastRequest: RequestInit | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    const mockFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      lastRequest = init;
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"done"}\\n\\ndata: {"type":"response.completed","response":{"status":"completed"}}\\n\\n',
        { headers: { "content-type":"text/event-stream" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  test("adds xAI web search while preserving OpenAI chat input", async () => {
    const target = grokCliProvider.resolveTarget("grok-4.5");
    if (!target) throw new Error("Grok model did not resolve");
    await grokCliProvider.call(target, {
      surface: "openai-chat",
      body: {
        model: "grok-4.5",
        stream: true,
        web_search_options: { filters: { allowed_domains: ["docs.x.ai"] } },
        messages: [{ role: "user", content: "Find the latest API change." }],
      },
    }, { kind: "oauth", value: "grok-token", providerMetadata: { userId: "x-user" } }, signal);

    const body = JSON.parse(String(lastRequest?.body)) as { tools?: Array<Record<string, unknown>> };
    expect(body.tools).toContainEqual({ type: "web_search", filters: { allowed_domains: ["docs.x.ai"] } });
    expect(lastRequest?.headers).toMatchObject({ "x-grok-client-identifier": "grok-shell", "x-userid": "x-user" });
  });
});

describe("Grok OAuth device flow", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("requests device authorization and preserves pending polling", async () => {
    const responses = [
      Response.json({ device_code: "device-1", user_code: "ABCD", verification_uri: "https://grok.com/device", interval: 5 }),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
    ];
    const mockFetch = async () => responses.shift() ?? Response.json({});
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
    const authorization = await requestGrokDeviceAuthorization();
    expect(authorization).toMatchObject({ deviceCode: "device-1", userCode: "ABCD", verificationUri: "https://grok.com/device" });
    expect(await pollGrokDeviceAuthorization(authorization.deviceCode)).toBeNull();
  });
});

describe("Antigravity provider", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastRequest: RequestInit | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    const mockFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      lastRequest = init;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}}\\n\\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  test("wraps chat messages in the Cloud Code envelope", async () => {
    const target = googleAntigravityProvider.resolveTarget("gemini-3.1-pro");
    if (!target) throw new Error("Antigravity model did not resolve");
    await googleAntigravityProvider.call(target, {
      surface: "openai-chat",
      body: {
        model: "gemini-3.1-pro",
        messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "Hello." }],
      },
    }, { kind: "oauth", value: "google-token", accountId: "account-1", providerMetadata: { projectId: "project-1" } }, signal);

    const body = JSON.parse(String(lastRequest?.body)) as { project?: string; model?: string; request?: { systemInstruction?: unknown; contents?: unknown[] } };
    expect(body.project).toBe("project-1");
    expect(body.model).toBe("gemini-3.1-pro-low");
    expect(body.request?.systemInstruction).toBeDefined();
    expect(body.request?.contents).toHaveLength(1);
  });
});
