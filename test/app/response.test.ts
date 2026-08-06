import { describe, expect, test } from "bun:test";
import {
  appendTerminalError,
  createResponseWriter,
  terminalErrorEvent,
  writeErrorResponse,
  writeNonStreamResponse,
  writeStreamResponse,
  type AppendTerminalErrorOptions,
} from "../../src/app/response";
import { createStreamLifecycle } from "../../src/app/recovery";
import {
  isTerminalEvent,
  publicErrorBody,
  type ProviderCallError,
  type ProviderOutput,
  type StreamEvent,
} from "../../src/domain/contracts";

/** Builds a NonStream provider output with a stable body shape. */
function nonStreamOutput(body: Record<string, unknown> = { ok: true }): Extract<ProviderOutput, { readonly mode: "non_stream" }> {
  return { mode: "non_stream", body };
}

/** Builds a Stream provider output yielding the given events. */
function streamOutput(events: readonly StreamEvent[]): Extract<ProviderOutput, { readonly mode: "stream" }> {
  return {
    mode: "stream",
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
        for (const event of events) yield event;
      },
    },
  };
}

/** Builds a typed ProviderCallError with sensible defaults. */
function makeError(overrides: Partial<ProviderCallError> = {}): ProviderCallError {
  return {
    statusCode: 502,
    kind: "provider_protocol_error",
    retryable: false,
    routeScope: "provider",
    source: "upstream",
    sanitizedMessage: "upstream failed",
    retryAt: null,
    ...overrides,
  };
}

/** Drains a stream body into an array of events. */
async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("writeNonStreamResponse", () => {
  test("writes a 200 JSON response carrying the provider body verbatim", () => {
    const body = { id: "chat_1", choices: [{ message: { role: "assistant", content: "hi" } }] };
    const response = writeNonStreamResponse(nonStreamOutput(body), "req_1");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body.mode).toBe("json");
    if (response.body.mode === "json") {
      expect(response.body.value).toEqual(body);
    }
  });

  test("does not embed the request id into the body", () => {
    const response = writeNonStreamResponse(nonStreamOutput({ a: 1 }), "req_secret_42");

    if (response.body.mode === "json") {
      const value = response.body.value as Record<string, unknown>;
      expect(value).not.toHaveProperty("request_id");
      expect(JSON.stringify(value)).not.toContain("req_secret_42");
    }
  });

  test("preserves an empty body object without fabricating content", () => {
    const response = writeNonStreamResponse(nonStreamOutput({}), "req_2");

    expect(response.status).toBe(200);
    if (response.body.mode === "json") {
      expect(response.body.value).toEqual({});
    }
  });
});

describe("writeStreamResponse", () => {
  test("writes SSE headers with the default event-stream content type", () => {
    const response = writeStreamResponse(streamOutput([]), "req_1");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.body.mode).toBe("stream");
  });

  test("honors a custom content-type override", () => {
    const response = writeStreamResponse(streamOutput([]), "req_1", { contentType: "application/x-ndjson" });

    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
  });

  test("marks the lifecycle headers as committed at presentation time", () => {
    const lifecycle = createStreamLifecycle();
    expect(lifecycle.headersCommitted).toBe(false);

    writeStreamResponse(streamOutput([]), "req_1", { lifecycle });

    expect(lifecycle.headersCommitted).toBe(true);
  });

  test("the returned iterable flushes the underlying stream events in order", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", id: "msg_1" },
      { type: "text_delta", text: "hello" },
      { type: "message_stop", reason: "completed" },
    ];
    const response = writeStreamResponse(streamOutput(events), "req_1");

    expect(response.body.mode).toBe("stream");
    if (response.body.mode === "stream") {
      const collected = await drain(response.body.events);
      expect(collected).toEqual(events);
    }
  });
});

describe("createResponseWriter", () => {
  test("dispatches non-stream output to the JSON presenter", () => {
    const writer = createResponseWriter();
    const response = writer.write(nonStreamOutput({ ok: true }), "req_1");

    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("json");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  test("dispatches stream output to the SSE presenter", () => {
    const writer = createResponseWriter();
    const response = writer.write(streamOutput([{ type: "message_stop", reason: "completed" }]), "req_1");

    expect(response.body.mode).toBe("stream");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  test("binds stream options so presentation is consistent across calls", () => {
    const lifecycle = createStreamLifecycle();
    const writer = createResponseWriter({ lifecycle, contentType: "application/x-ndjson" });

    const first = writer.write(streamOutput([]), "req_1");
    const second = writer.write(streamOutput([]), "req_2");

    expect(first.headers.get("content-type")).toBe("application/x-ndjson");
    expect(second.headers.get("content-type")).toBe("application/x-ndjson");
    expect(lifecycle.headersCommitted).toBe(true);
  });
});

describe("writeErrorResponse", () => {
  test("uses the typed status code and wraps the public error body", () => {
    const error = makeError({ statusCode: 429, kind: "provider_rate_limited", sanitizedMessage: "slow down", routeScope: "account", source: "upstream" });
    const response = writeErrorResponse(error, "req_1");

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (response.body.mode === "json") {
      expect(response.body.value).toEqual(publicErrorBody(error, "req_1"));
    }
  });

  test("falls back to 502 when the status code is null", () => {
    const error = makeError({ statusCode: null, kind: "provider_protocol_error" });
    const response = writeErrorResponse(error, "req_1");

    expect(response.status).toBe(502);
  });

  test("embeds the request id into the public error body", () => {
    const error = makeError({ statusCode: 401, kind: "authentication_failed", routeScope: "account" });
    const response = writeErrorResponse(error, "req_secret_99");

    if (response.body.mode === "json") {
      const body = response.body.value as { error: { request_id: string } };
      expect(body.error.request_id).toBe("req_secret_99");
    }
  });

  test("never exposes the raw upstream message, only the sanitized one", () => {
    const error = makeError({
      statusCode: 500,
      kind: "provider_unavailable",
      sanitizedMessage: "provider failed (sanitized)",
    });
    const response = writeErrorResponse(error, "req_1");

    if (response.body.mode === "json") {
      const text = JSON.stringify(response.body.value);
      expect(text).toContain("provider failed (sanitized)");
    }
  });
});

describe("terminalErrorEvent", () => {
  test("produces a terminal message_stop event with an error reason", () => {
    const event = terminalErrorEvent();

    expect(event.type).toBe("message_stop");
    expect(isTerminalEvent(event)).toBe(true);
    if (event.type === "message_stop") {
      expect(event.reason).toBe("error");
    }
  });

  test("is recognized as terminal by the domain contract", () => {
    const event = terminalErrorEvent();
    expect(isTerminalEvent(event)).toBe(true);
  });
});

describe("appendTerminalError", () => {
  /** Builds an async iterable from a list of events, optionally throwing mid-stream. */
  function iterableFrom(
    events: readonly StreamEvent[],
    options: { throwAfter?: number; error?: unknown } = {},
  ): AsyncIterable<StreamEvent> {
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
        for (let i = 0; i < events.length; i += 1) {
          yield events[i]!;
          if (options.throwAfter === i) throw options.error ?? new Error("stream broke");
        }
      },
    };
  }

  test("appends a terminal error event when the stream completes without one", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", id: "msg_1" },
      { type: "text_delta", text: "partial" },
    ];
    const result = await drain(appendTerminalError(iterableFrom(events)));

    expect(result).toHaveLength(3);
    expect(result[2]).toEqual(terminalErrorEvent());
    expect(isTerminalEvent(result[2]!)).toBe(true);
  });

  test("does not append a second terminal event when the stream already terminated", async () => {
    const terminal: StreamEvent = { type: "message_stop", reason: "completed" };
    const events: StreamEvent[] = [
      { type: "message_start", id: "msg_1" },
      terminal,
    ];
    const result = await drain(appendTerminalError(iterableFrom(events)));

    expect(result).toEqual(events);
    expect(result[result.length - 1]).toEqual(terminal);
  });

  test("fires the onError callback and still appends a terminal error event on mid-stream failure", async () => {
    const captured: unknown[] = [];
    const failure = new Error("stream broke");
    const opts: AppendTerminalErrorOptions = { onError: (error) => captured.push(error) };
    const events: StreamEvent[] = [{ type: "message_start", id: "msg_1" }];

    const result = await drain(appendTerminalError(iterableFrom(events, { throwAfter: 0, error: failure }), opts));

    expect(captured).toEqual([failure]);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual(terminalErrorEvent());
  });

  test("does not append a terminal event when a failure occurs after a terminal event", async () => {
    const terminal: StreamEvent = { type: "message_stop", reason: "completed" };
    const captured: unknown[] = [];
    const failure = new Error("post-terminal failure");
    const events: StreamEvent[] = [terminal];

    const result = await drain(
      appendTerminalError(iterableFrom(events, { throwAfter: 0, error: failure }), { onError: (error) => captured.push(error) }),
    );

    expect(captured).toEqual([failure]);
    expect(result).toEqual([terminal]);
  });

  test("forwards every event verbatim, including deltas and usage", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", id: "msg_1" },
      { type: "thinking_delta", text: "hmm" },
      { type: "text_delta", text: "hi" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" } },
      { type: "message_stop", reason: "completed" },
    ];
    const result = await drain(appendTerminalError(iterableFrom(events)));

    expect(result).toEqual(events);
  });
});
