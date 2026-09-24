import { describe, expect, test } from "bun:test";
import { decodeSseEvents, type SseEvent } from "../../src/transport/streaming";
import type { CanonicalEvent, CanonicalRequest } from "../../src/transport/canonical-model";
import { decodeChatSseStream } from "../../src/protocol/response/chat";
import { decodeResponsesSseStream } from "../../src/protocol/response/responses";
import { CodexStreamFrameProcessor } from "../../src/protocol/response/codex";
import { createAntigravityAdapter } from "../../src/providers/integrations/antigravity/antigravity";
import type { ProviderDispatchTarget, ProviderDispatchContext } from "../../src/providers/provider-registry";

/**
 * Phase B SSE framing golden test.
 *
 * All four streaming consumers (chat, responses, codex, antigravity) frame
 * bytes through the single `decodeSseEvents` kernel. The meaningful invariant
 * is framing-invariance per consumer: one recorded byte stream (multibyte
 * split chunks, `\r\n` endings, `event:` fields, comment keepalives, `[DONE]`)
 * delivered under adversarial chunkings MUST yield identical event sequences.
 * (A single stream cannot be semantically valid for all four wire dialects at
 * once, so each consumer gets a dialect-appropriate recording with the same
 * adversarial framing.)
 */

const encoder = new TextEncoder();

function streamOfBytes(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Whole, two adversarial byte-splits (one inside a multibyte char), and 1-byte chunks. */
function chunkings(full: string): Uint8Array[][] {
  const bytes = encoder.encode(full);
  const midMultibyte = bytes.indexOf(0xa9); // second byte of "é" (0xc3 0xa9)
  const split = midMultibyte > 0 ? midMultibyte : Math.floor(bytes.length / 2);
  const single: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i++) single.push(bytes.slice(i, i + 1));
  return [
    [bytes],
    [bytes.slice(0, split), bytes.slice(split, split + 7), bytes.slice(split + 7)],
    single,
  ];
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

function fakeRequest(model = "golden-model"): CanonicalRequest {
  return {
    model,
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  } as CanonicalRequest;
}

function textOf(events: CanonicalEvent[]): string {
  return events
    .map((event) => {
      if (event.type === "content_delta" && event.content.kind === "text") return event.content.text;
      return "";
    })
    .join("");
}

// Recorded chat-dialect stream: event: field, comment keepalive, \r\n, [DONE].
const CHAT_STREAM =
  `event: message\r\ndata: {"choices":[{"delta":{"content":"Hé"}}]}\r\n\r\n` +
  `data: {"choices":[{"delta":{"content":"llo"}}]}\r\n\r\n` +
  `: keepalive ping\r\n\r\n` +
  `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n` +
  `data: [DONE]\r\n\r\n`;

const CHAT_FRAMES = [
  `{"choices":[{"delta":{"content":"Hé"}}]}`,
  `{"choices":[{"delta":{"content":"llo"}}]}`,
  `{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
  "[DONE]",
];

describe("SSE framing golden (Phase B)", () => {
  test("kernel: identical frames under adversarial chunkings", async () => {
    const runs: SseEvent[][] = [];
    for (const chunks of chunkings(CHAT_STREAM)) {
      runs.push(await collect(decodeSseEvents(streamOfBytes(chunks))));
    }
    for (const frames of runs) {
      expect(frames.map((frame) => frame.data)).toEqual(CHAT_FRAMES);
      expect(frames[0]?.event).toBe("message");
      expect(frames[1]?.event).toBeNull();
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  test("chat consumer: identical canonical events under adversarial chunkings", async () => {
    const runs: CanonicalEvent[][] = [];
    for (const chunks of chunkings(CHAT_STREAM)) {
      runs.push(await collect(decodeChatSseStream(streamOfBytes(chunks), fakeRequest())));
    }
    for (const events of runs) {
      expect(events).toHaveLength(4);
      expect(textOf(events)).toBe("Héllo");
      expect(events[0]?.type).toBe("response_start");
      expect(events[3]).toMatchObject({ type: "terminal", state: "complete" });
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  test("responses consumer: identical canonical events under adversarial chunkings", async () => {
    const stream =
      `data: {"type":"response.output_text.delta","delta":"Hé"}\r\n\r\n` +
      `data: {"type":"response.output_text.delta","delta":"llo"}\r\n\r\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\r\n\r\n` +
      `data: [DONE]\r\n\r\n`;
    const runs: CanonicalEvent[][] = [];
    for (const chunks of chunkings(stream)) {
      runs.push(await collect(decodeResponsesSseStream(streamOfBytes(chunks), fakeRequest())));
    }
    for (const events of runs) {
      expect(events).toHaveLength(4);
      expect(textOf(events)).toBe("Héllo");
      expect(events[3]).toMatchObject({ type: "terminal", state: "complete" });
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  test("codex consumer: identical processor events under adversarial chunkings", async () => {
    // Mirrors src/providers/codex/codex.ts: decodeSseEvents → JSON.parse →
    // CodexStreamFrameProcessor → terminalEvent.
    const stream =
      `data: {"type":"response.output_text.delta","delta":"Hé"}\r\n\r\n` +
      `data: {"type":"response.output_text.delta","delta":"llo"}\r\n\r\n` +
      `data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n` +
      `data: [DONE]\r\n\r\n`;
    async function consume(chunks: readonly Uint8Array[]): Promise<CanonicalEvent[]> {
      const processor = new CodexStreamFrameProcessor(2);
      const events: CanonicalEvent[] = [];
      for await (const sse of decodeSseEvents(streamOfBytes(chunks))) {
        const data = sse.data.trim();
        if (data === "[DONE]") break;
        if (data.length === 0) continue;
        try {
          events.push(...processor.process(JSON.parse(data) as Record<string, unknown>));
        } catch {
          // ignore malformed line (matches codex.ts)
        }
      }
      events.push(processor.terminalEvent());
      return events;
    }
    const runs: CanonicalEvent[][] = [];
    for (const chunks of chunkings(stream)) runs.push(await consume(chunks));
    for (const events of runs) {
      expect(textOf(events)).toBe("Héllo");
      expect(events[events.length - 1]?.type).toBe("terminal");
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  test("antigravity consumer: identical dispatch events under adversarial chunkings", async () => {
    const stream =
      `data: {"candidates":[{"content":{"parts":[{"text":"Hé"}]}}]}\r\n\r\n` +
      `data: {"candidates":[{"content":{"parts":[{"text":"llo"}]},"finishReason":"STOP"}]}\r\n\r\n` +
      `data: [DONE]\r\n\r\n`;
    async function dispatch(chunks: readonly Uint8Array[]): Promise<CanonicalEvent[]> {
      const fetchStub = (async (input: RequestInfo | URL) => {
        if (String(input).includes("streamGenerateContent")) {
          return new Response(streamOfBytes(chunks), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("{}", { status: 404 });
      }) as unknown as typeof fetch;
      const adapter = createAntigravityAdapter({ fetch: fetchStub });
      const candidate: ProviderDispatchTarget = {
        provider_id: "antigravity",
        model_id: "claude-sonnet-4-6",
        wire_family: "chat",
        endpoint_path: "/v1internal:streamGenerateContent?alt=sse",
        capabilities: {},
      };
      const context: ProviderDispatchContext = {
        credential: {
          provider_id: "antigravity",
          credential_kind: "oauth",
          secret: encoder.encode("golden-test-token"),
        },
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
        outbound_fetch: fetchStub,
      };
      return collect(adapter.dispatch(fakeRequest("claude-sonnet-4-6"), candidate, context));
    }
    const [whole, split] = chunkings(stream);
    if (!whole || !split) throw new Error("golden chunkings must be non-empty");
    const first = await dispatch(whole);
    const second = await dispatch(split);
    expect(textOf(first)).toBe("Héllo");
    expect(first[first.length - 1]).toMatchObject({ type: "terminal", state: "complete" });
    expect(second).toEqual(first);
  });
});
