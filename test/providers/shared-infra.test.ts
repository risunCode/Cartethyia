import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  AbortCoordinator,
  ProviderAdapterError,
  executeFetch,
  mapSseStream,
  messageText,
  parseSseData,
  readJsonObject,
  readUpstreamError,
  toProviderCallError,
  type AbortCause,
} from "../../src/providers/shared";
import { ProtocolCodecError } from "../../src/domain/protocols/errors";
import type { NormalizedMessage, ProviderCallError, StreamEvent } from "../../src/domain/contracts";

/** Builds a ReadableStream from a list of string/byte chunks. */
function streamBody(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

/** Drains an async iterable into an array. */
async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of iterable) collected.push(item);
  return collected;
}

/** Builds a non-aborted caller signal + coordinator with the given options. */
function freshCoordinator(opts: { connectTimeoutMs?: number; totalTimeoutMs?: number; idleTimeoutMs?: number } = {}): {
  controller: AbortController;
  coordinator: AbortCoordinator;
} {
  const controller = new AbortController();
  return { controller, coordinator: new AbortCoordinator(controller.signal, opts) };
}

describe("AbortCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("connect timeout fires and attributes the cause to connect_timeout", () => {
    const { coordinator } = freshCoordinator({ connectTimeoutMs: 1 });
    vi.advanceTimersByTime(30);
    expect(coordinator.signal.aborted).toBe(true);
    expect(coordinator.causeOf()).toBe<AbortCause>("connect_timeout");
  });

  test("total timeout fires and attributes the cause to total_timeout", () => {
    const { coordinator } = freshCoordinator({ totalTimeoutMs: 1 });
    vi.advanceTimersByTime(30);
    expect(coordinator.signal.aborted).toBe(true);
    expect(coordinator.causeOf()).toBe<AbortCause>("total_timeout");
  });

  test("idle timeout fires after resetIdle and attributes the cause to idle_timeout", () => {
    const { coordinator } = freshCoordinator({ idleTimeoutMs: 2 });
    coordinator.resetIdle();
    vi.advanceTimersByTime(30);
    expect(coordinator.signal.aborted).toBe(true);
    expect(coordinator.causeOf()).toBe<AbortCause>("idle_timeout");
  });

  test("caller abort propagates and attributes the cause to caller", () => {
    const controller = new AbortController();
    const coordinator = new AbortCoordinator(controller.signal);
    controller.abort();
    expect(coordinator.signal.aborted).toBe(true);
    expect(coordinator.causeOf()).toBe<AbortCause>("caller");
  });

  test("pre-aborted caller signal aborts immediately with caller cause", () => {
    const controller = new AbortController();
    controller.abort();
    const coordinator = new AbortCoordinator(controller.signal);
    expect(coordinator.signal.aborted).toBe(true);
    expect(coordinator.causeOf()).toBe<AbortCause>("caller");
  });

  test("markHeadersReceived stops the connect timer so no connect timeout fires", () => {
    const { coordinator } = freshCoordinator({ connectTimeoutMs: 1 });
    coordinator.markHeadersReceived();
    vi.advanceTimersByTime(30);
    expect(coordinator.signal.aborted).toBe(false);
  });

  test("resetIdle re-arms the idle timer so a late chunk avoids idle timeout", () => {
    const { coordinator } = freshCoordinator({ idleTimeoutMs: 5 });
    vi.advanceTimersByTime(15);
    expect(coordinator.signal.aborted).toBe(false);
    coordinator.resetIdle();
    vi.advanceTimersByTime(15);
    expect(coordinator.signal.aborted).toBe(true);
    expect(coordinator.causeOf()).toBe<AbortCause>("idle_timeout");
  });

  test("onAbort fires when the coordinator aborts and returns an unsubscribe", () => {
    const controller = new AbortController();
    const coordinator = new AbortCoordinator(controller.signal);
    const calls: AbortCause[] = [];
    const unsubscribe = coordinator.onAbort(() => calls.push(coordinator.causeOf()));

    controller.abort();
    expect(calls).toEqual<AbortCause[]>(["caller"]);
    unsubscribe();
  });

  test("onAbort fires immediately when the coordinator is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const coordinator = new AbortCoordinator(controller.signal);
    const calls: number[] = [];
    coordinator.onAbort(() => calls.push(1));
    expect(calls).toEqual([1]);
  });

  test("dispose cleans up timers so no timeout fires afterward", () => {
    const { coordinator } = freshCoordinator({ connectTimeoutMs: 1, totalTimeoutMs: 2, idleTimeoutMs: 3 });
    coordinator.dispose();
    vi.advanceTimersByTime(30);
    expect(coordinator.signal.aborted).toBe(false);
  });

  test("dispose is idempotent", () => {
    const { coordinator } = freshCoordinator({ connectTimeoutMs: 1 });
    expect(() => {
      coordinator.dispose();
      coordinator.dispose();
    }).not.toThrow();
  });
});

describe("executeFetch", () => {
  const originalFetch = globalThis.fetch;

  test("returns the response and marks headers received on success", async () => {
    globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    try {
      const { coordinator } = freshCoordinator({ connectTimeoutMs: 100 });
      const response = await executeFetch("https://example.test/v1/chat", {}, coordinator);
      expect(response.status).toBe(200);
      expect(coordinator.signal.aborted).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps a TypeError to a retryable network_unavailable error", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed: DNS resolution");
    }) as unknown as typeof fetch;
    try {
      const { coordinator } = freshCoordinator();
      const error = await executeFetch("https://example.test", {}, coordinator).catch((caught) => caught);
      expect(error).toBeInstanceOf(ProviderAdapterError);
      const mapped = (error as ProviderAdapterError).toProviderCallError();
      expect(mapped.kind).toBe("network_unavailable");
      expect(mapped.retryable).toBe(true);
      expect(mapped.routeScope).toBe("proxy");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("routes a caller abort to a non-retryable client_aborted error", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    try {
      const controller = new AbortController();
      const coordinator = new AbortCoordinator(controller.signal);
      controller.abort();
      const error = await executeFetch("https://example.test", {}, coordinator).catch((caught) => caught);
      expect(error).toBeInstanceOf(ProviderAdapterError);
      const mapped = (error as ProviderAdapterError).toProviderCallError();
      expect(mapped.kind).toBe("client_aborted");
      expect(mapped.retryable).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("routes a coordinator timeout abort to a retryable network_unavailable error", async () => {
    vi.useFakeTimers();
    globalThis.fetch = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    try {
      const { coordinator } = freshCoordinator({ connectTimeoutMs: 1 });
      vi.advanceTimersByTime(30);
      const error = await executeFetch("https://example.test", {}, coordinator).catch((caught) => caught);
      expect(error).toBeInstanceOf(ProviderAdapterError);
      const mapped = (error as ProviderAdapterError).toProviderCallError();
      expect(mapped.kind).toBe("network_unavailable");
      expect(mapped.retryable).toBe(true);
      expect(mapped.routeScope).toBe("proxy");
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });
});

describe("readJsonObject", () => {
  test("reads a valid JSON object body", async () => {
    const response = new Response('{"id":"chat_1","ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    const { coordinator } = freshCoordinator();
    const parsed = await readJsonObject(response, coordinator);
    expect(parsed).toEqual({ id: "chat_1", ok: true });
  });

  test("rejects a non-object JSON body (array) with provider_protocol_error", async () => {
    const response = new Response("[1,2,3]", { status: 200 });
    const { coordinator } = freshCoordinator();
    const error = await readJsonObject(response, coordinator).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    const mapped = (error as ProviderAdapterError).toProviderCallError();
    expect(mapped.kind).toBe("provider_protocol_error");
    expect(mapped.retryable).toBe(false);
  });

  test("rejects a non-object JSON body (primitive) with provider_protocol_error", async () => {
    const response = new Response('"just a string"', { status: 200 });
    const { coordinator } = freshCoordinator();
    const error = await readJsonObject(response, coordinator).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect((error as ProviderAdapterError).toProviderCallError().kind).toBe("provider_protocol_error");
  });

  test("rejects invalid JSON with provider_protocol_error", async () => {
    const response = new Response("{not valid json}", { status: 200 });
    const { coordinator } = freshCoordinator();
    const error = await readJsonObject(response, coordinator).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect((error as ProviderAdapterError).toProviderCallError().kind).toBe("provider_protocol_error");
  });

  test("does not treat an empty object as an error", async () => {
    const response = new Response("{}", { status: 200 });
    const { coordinator } = freshCoordinator();
    const parsed = await readJsonObject(response, coordinator);
    expect(parsed).toEqual({});
  });
});

describe("mapSseStream", () => {
  /** Encodes a list of SSE data payloads into a text/event-stream body. */
  function sseBody(dataLines: readonly string[]): string {
    return dataLines.map((data) => `data: ${data}\n\n`).join("");
  }

  /** Mapper that treats `finish`/`stop`/[DONE] as terminal; echoes everything else. */
  function terminalAwareMapper(sse: { data: string }): StreamEvent | readonly StreamEvent[] | null {
    const data = sse.data;
    if (data === "[DONE]" || data.includes("finish") || data.includes("stop")) {
      return { type: "message_stop", reason: "completed" };
    }
    return { type: "text_delta", text: data };
  }

  function decodeConfig(lines: readonly string[]): { body: ReadableStream<Uint8Array>; coordinator: AbortCoordinator; maxLineBytes: number } {
    return {
      body: streamBody([sseBody(lines)]),
      coordinator: new AbortCoordinator(new AbortController().signal),
      maxLineBytes: 4_096,
    };
  }

  test("detects the [DONE] sentinel as a terminal event", async () => {
    const config = decodeConfig(['{"delta":"hi"}', "[DONE]"]);
    const events = await drain(mapSseStream(config, terminalAwareMapper));
    expect(events[events.length - 1]?.type).toBe("message_stop");
  });

  test("detects a finish reason as a terminal event", async () => {
    const config = decodeConfig(['{"delta":"hi"}', '{"finish":"stop"}']);
    const events = await drain(mapSseStream(config, terminalAwareMapper));
    expect(events[events.length - 1]?.type).toBe("message_stop");
  });

  test("throws stream_truncated when the stream ends without a terminal event", async () => {
    const config = decodeConfig(['{"delta":"hi"}', '{"delta":"there"}']);
    const error = await drain(mapSseStream(config, terminalAwareMapper)).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect((error as ProviderAdapterError).toProviderCallError().kind).toBe("stream_truncated");
  });

  test("emits no events for an empty stream and throws stream_truncated", async () => {
    const config = decodeConfig([]);
    const error = await drain(mapSseStream(config, terminalAwareMapper)).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect((error as ProviderAdapterError).toProviderCallError().kind).toBe("stream_truncated");
  });

  test("rejects a line exceeding the byte bound with provider_protocol_error", async () => {
    const config = {
      body: streamBody([`data: ${"x".repeat(2_048)}\n\n`]),
      coordinator: new AbortCoordinator(new AbortController().signal),
      maxLineBytes: 1_024,
    };
    const error = await drain(mapSseStream(config, terminalAwareMapper)).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect((error as ProviderAdapterError).toProviderCallError().kind).toBe("provider_protocol_error");
  });
});

describe("parseSseData", () => {
  test("[DONE] returns null as the terminal sentinel", () => {
    expect(parseSseData("[DONE]")).toBeNull();
  });

  test("parses valid JSON data into the corresponding value", () => {
    expect(parseSseData('{"delta":"hello"}')).toEqual({ delta: "hello" });
  });

  test("parses a JSON array payload", () => {
    expect(parseSseData("[1,2,3]")).toEqual([1, 2, 3]);
  });

  test("throws a ProviderAdapterError on invalid JSON", () => {
    expect(() => parseSseData("{not json}")).toThrow(ProviderAdapterError);
    try {
      parseSseData("not json");
    } catch (error) {
      const mapped = (error as ProviderAdapterError).toProviderCallError();
      expect(mapped.kind).toBe("provider_protocol_error");
      expect(mapped.retryable).toBe(false);
    }
  });
});

describe("toProviderCallError", () => {
  test("maps a ProviderAdapterError through its own toProviderCallError", () => {
    const adapter = new ProviderAdapterError({ kind: "model_not_found", message: "no such model", statusCode: 404, routeScope: "provider" });
    const mapped = toProviderCallError(adapter);
    expect(mapped.statusCode).toBe(404);
    expect(mapped.kind).toBe("model_not_found");
    expect(mapped.retryable).toBe(false);
    expect(mapped.routeScope).toBe("provider");
  });

  test("maps a ProtocolCodecError through its toProviderCallError with a sanitized message", () => {
    const codec = new ProtocolCodecError({ kind: "invalid_request", message: "malformed payload", statusCode: 400 });
    const mapped = toProviderCallError(codec);
    expect(mapped.kind).toBe("invalid_request");
    expect(mapped.statusCode).toBe(400);
    expect(mapped.sanitizedMessage).toBe("malformed payload");
  });

  test("maps an AbortError to a non-retryable client_aborted", () => {
    const error = new DOMException("aborted", "AbortError");
    const mapped = toProviderCallError(error);
    expect(mapped.kind).toBe("client_aborted");
    expect(mapped.retryable).toBe(false);
    expect(mapped.source).toBe("client");
  });

  test("maps a TypeError to a retryable network_unavailable scoped to proxy", () => {
    const mapped = toProviderCallError(new TypeError("fetch failed"));
    expect(mapped.kind).toBe("network_unavailable");
    expect(mapped.retryable).toBe(true);
    expect(mapped.routeScope).toBe("proxy");
    expect(mapped.source).toBe("upstream");
  });

  test("maps a ReferenceError to an internal_error", () => {
    const mapped = toProviderCallError(new ReferenceError("x is not defined"));
    expect(mapped.kind).toBe("internal_error");
    expect(mapped.retryable).toBe(false);
    expect(mapped.source).toBe("internal");
  });

  test("maps a SyntaxError to an internal_error", () => {
    const mapped = toProviderCallError(new SyntaxError("unexpected token"));
    expect(mapped.kind).toBe("internal_error");
    expect(mapped.retryable).toBe(false);
    expect(mapped.source).toBe("internal");
  });

  test("maps an unknown error to a provider_protocol_error", () => {
    const mapped = toProviderCallError(new Error("unknown failure"));
    expect(mapped.kind).toBe("provider_protocol_error");
    expect(mapped.retryable).toBe(false);
    expect(mapped.routeScope).toBe("provider");
  });

  test("sanitizes credentials embedded in the error message", () => {
    const mapped = toProviderCallError(new Error("Bearer sk-secret-12345 leaked"));
    expect(mapped.sanitizedMessage).not.toContain("sk-secret-12345");
    expect(mapped.sanitizedMessage).toContain("redacted");
  });
});

describe("mapUpstreamError (via readUpstreamError status matrix)", () => {
  /** Reads the typed error thrown by readUpstreamError for a given status. */
  async function mappedForStatus(status: number, body: string = `{"error":{"message":"fail"}}`): Promise<ProviderCallError> {
    const response = new Response(body, { status });
    const error = await readUpstreamError(response).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    return (error as ProviderAdapterError).toProviderCallError();
  }

  test("400 maps to invalid_request scoped to provider", async () => {
    expect((await mappedForStatus(400)).kind).toBe("invalid_request");
  });

  test("401 maps to authentication_failed scoped to account", async () => {
    const mapped = await mappedForStatus(401);
    expect(mapped.kind).toBe("authentication_failed");
    expect(mapped.routeScope).toBe("account");
  });

  test("403 maps to authorization_denied scoped to account", async () => {
    const mapped = await mappedForStatus(403);
    expect(mapped.kind).toBe("authorization_denied");
    expect(mapped.routeScope).toBe("account");
  });

  test("404 maps to model_not_found scoped to provider", async () => {
    const mapped = await mappedForStatus(404);
    expect(mapped.kind).toBe("model_not_found");
    expect(mapped.routeScope).toBe("provider");
  });

  test("429 maps to provider_rate_limited scoped to account", async () => {
    const mapped = await mappedForStatus(429);
    expect(mapped.kind).toBe("provider_rate_limited");
    expect(mapped.retryable).toBe(true);
    expect(mapped.routeScope).toBe("account");
  });

  test("429 with quota/billing hint maps to quota_exceeded", async () => {
    const mapped = await mappedForStatus(429, `{"error":{"message":"insufficient quota","type":"billing"}}`);
    expect(mapped.kind).toBe("quota_exceeded");
  });

  test("500 maps to a retryable provider_unavailable", async () => {
    const mapped = await mappedForStatus(500);
    expect(mapped.kind).toBe("provider_unavailable");
    expect(mapped.retryable).toBe(true);
  });

  test("502/503/504 map to retryable provider_unavailable", async () => {
    expect((await mappedForStatus(502)).kind).toBe("provider_unavailable");
    expect((await mappedForStatus(503)).kind).toBe("provider_unavailable");
    expect((await mappedForStatus(504)).kind).toBe("provider_unavailable");
  });

  test("unknown 4xx status maps to provider_protocol_error", async () => {
    const mapped = await mappedForStatus(418);
    expect(mapped.kind).toBe("provider_protocol_error");
  });

  test("407 maps to a retryable network_unavailable scoped to proxy", async () => {
    const mapped = await mappedForStatus(407);
    expect(mapped.kind).toBe("network_unavailable");
    expect(mapped.retryable).toBe(true);
    expect(mapped.routeScope).toBe("proxy");
  });

  test("408 maps to a retryable provider_unavailable", async () => {
    const mapped = await mappedForStatus(408);
    expect(mapped.kind).toBe("provider_unavailable");
    expect(mapped.retryable).toBe(true);
  });

  test("409 maps to a retryable concurrency_exceeded", async () => {
    const mapped = await mappedForStatus(409);
    expect(mapped.kind).toBe("concurrency_exceeded");
    expect(mapped.retryable).toBe(true);
  });
});

describe("messageText", () => {
  /** Builds a NormalizedMessage with the given content blocks. */
  function message(content: NormalizedMessage["content"]): NormalizedMessage {
    return { role: "assistant", content };
  }

  test("joins multiple text blocks with a newline separator", () => {
    const msg = message([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(messageText(msg)).toBe("first\nsecond");
  });

  test("returns the text of a single text block", () => {
    const msg = message([{ type: "text", text: "only" }]);
    expect(messageText(msg)).toBe("only");
  });

  test("returns an empty string for a message with no content blocks", () => {
    const msg = message([]);
    expect(messageText(msg)).toBe("");
  });

  test("ignores non-text blocks and joins only the text ones", () => {
    const msg = message([
      { type: "image", image: { kind: "url", value: "https://example.test/img.png", mediaType: "image/png" } },
      { type: "text", text: "kept" },
      { type: "tool_use", toolName: "search", toolCallId: "call_1", toolArguments: "{}" },
      { type: "text", text: "also kept" },
    ]);
    expect(messageText(msg)).toBe("kept\nalso kept");
  });

  test("returns an empty string when all blocks are non-text", () => {
    const msg = message([
      { type: "image", image: { kind: "url", value: "https://example.test/img.png", mediaType: "image/png" } },
      { type: "tool_use", toolName: "search", toolCallId: "call_1", toolArguments: "{}" },
    ]);
    expect(messageText(msg)).toBe("");
  });

  test("treats a text block with undefined text as an empty contribution", () => {
    const msg = message([{ type: "text" }, { type: "text", text: "present" }]);
    expect(messageText(msg)).toBe("\npresent");
  });
});
