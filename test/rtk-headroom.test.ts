import { describe, expect, test } from "bun:test";
import type { NormalizedMessage, ProxyRequest } from "../src/application/contracts";
import { createCleanupStack } from "../src/application/contracts";
import { isRecord } from "../src/application/protocols";
import { normalizeChatRequest } from "../src/open-sse/translate";
import { createOpenAIChatStreamMapper } from "../src/open-sse/transport/protocols/openai";
import { applyTokenSaver } from "../src/open-sse/rtk";
import { compressWithHeadroom } from "../src/open-sse/rtk/headroom";
import { recoverCall } from "../src/open-sse/handlers/recovery";
import { ProviderAdapterError } from "../src/open-sse/transport/errors";

const limits = {
  maxBodyBytes: 10_000_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};

function request(messages: readonly NormalizedMessage[]): ProxyRequest {
  return {
    model: "test-model",
    messages,
    tools: [],
    stream: true,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits,
  };
}

describe("RTK and Headroom", () => {
  test("emergency RTK compresses old tool results without dropping turns", () => {
    const longText = Array.from({ length: 1_000 }, (_, index) => `line ${index}`).join("\n");
    const messages: NormalizedMessage[] = [
      { role: "tool", content: [{ type: "tool_result", text: longText }] },
      ...Array.from({ length: 511 }, () => ({ role: "user" as const, content: [{ type: "text" as const, text: "keep" }] })),
    ];
    const result = applyTokenSaver(request(messages), { enabled: false, emergency: true, quality: "balanced" });
    expect(result.messages).toHaveLength(512);
    expect(result.messages[0]?.content[0]?.text?.length).toBeLessThan(longText.length);
    expect(result.messages[511]?.content[0]?.text).toBe("keep");
  });

  test("Headroom applies only smaller tool-result responses", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (incoming) => {
        if (new URL(incoming.url).pathname !== "/v1/compress") return new Response("not found", { status: 404 });
        const payload: unknown = await incoming.json();
        const count = isRecord(payload) && Array.isArray(payload.messages) ? payload.messages.length : 0;
        return Response.json({ messages: Array.from({ length: count }, () => ({ role: "tool", content: "compressed" })) });
      },
    });
    try {
      const original = "x".repeat(1_000);
      const outcome = await compressWithHeadroom(
        request([{ role: "tool", content: [{ type: "tool_result", text: original }] }]),
        { enabled: true, url: `http://127.0.0.1:${server.port}`, timeoutMs: 1_000, compressUserMessages: false },
      );
      expect(outcome.summary.compressedBlocks).toBe(1);
      expect(outcome.request.messages[0]?.content[0]?.text).toBe("compressed");
    } finally {
      server.stop(true);
    }
  });

  test("Headroom fails open when the service is unavailable", async () => {
    const outcome = await compressWithHeadroom(
      request([{ role: "tool", content: [{ type: "tool_result", text: "x".repeat(1_000) }] }]),
      { enabled: true, url: "http://127.0.0.1:1", timeoutMs: 250, compressUserMessages: false },
    );
    expect(outcome.summary.compressedBlocks).toBe(0);
    expect(outcome.request.messages[0]?.content[0]?.text).toHaveLength(1_000);
  });

  test("message overflow explains the recovery action", () => {
    const result = normalizeChatRequest(
      { model: "test-model", messages: Array.from({ length: 2_049 }, () => ({ role: "user", content: "x" })) },
      { signal: new AbortController().signal, limits },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.sanitizedMessage).toContain("received 2049");
    expect(result.error.sanitizedMessage).toContain("Please use /compact");
  });

  test("OpenAI error finish reason remains a terminal error", () => {
    const mapper = createOpenAIChatStreamMapper();
    mapper({ event: null, data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "error" }] }) });
    const mapped = mapper({ event: null, data: "[DONE]" });
    const events = Array.isArray(mapped) ? mapped : mapped === null ? [] : [mapped];
    expect(events.some((event) => event.type === "message_stop" && event.reason === "error")).toBe(true);
  });

  test("pre-output stream timeout retries and can recover", async () => {
    let attempts = 0;
    const output = await recoverCall({
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            mode: "stream" as const,
            events: (async function* () {
              throw new ProviderAdapterError({ kind: "stream_timeout", message: "timed out", retryable: true, routeScope: "provider" });
            })(),
          };
        }
        return {
          mode: "stream" as const,
          events: (async function* () {
            yield { type: "message_start" as const, id: "recovered" };
            yield { type: "text_delta" as const, text: "ok" };
            yield { type: "message_stop" as const, reason: "completed" as const };
          })(),
        };
      },
      maxAttempts: 2,
      signal: new AbortController().signal,
      cleanup: createCleanupStack(),
      waitBeforeRetry: async () => {},
    });
    if (output.mode !== "stream") throw new Error("expected stream output");
    const events = [];
    for await (const event of output.events) events.push(event);
    expect(attempts).toBe(2);
    expect(events.some((event) => event.type === "text_delta" && event.text === "ok")).toBe(true);
  });
});
