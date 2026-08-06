import { describe, expect, test } from "bun:test";
import {
  createStreamLifecycle,
  isProviderCallError,
  recoverCall,
  toProviderCallError,
  trackStream,
  waitBeforeRetry,
  type StreamLifecycleController,
} from "../../src/app/recovery";
import { StreamDecodeError } from "../../src/domain/protocols";
import {
  createCleanupStack,
  isTerminalEvent,
  type ProviderCallError,
  type ProviderOutput,
  type StreamEvent,
} from "../../src/domain/contracts";

/** Builds a non-stream provider output with a stable body. */
function nonStreamOutput(body: Record<string, unknown> = { ok: true }): Extract<ProviderOutput, { readonly mode: "non_stream" }> {
  return { mode: "non_stream", body };
}

/** Builds a stream provider output yielding the given events. */
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

/** Builds a stream provider output from an async iterable. */
function streamFromIterable(events: AsyncIterable<StreamEvent>): Extract<ProviderOutput, { readonly mode: "stream" }> {
  return { mode: "stream", events };
}

/** A retryable provider call error used across recovery tests. */
function retryableError(overrides: Partial<ProviderCallError> = {}): ProviderCallError {
  return { statusCode: 503, kind: "provider_unavailable", retryable: true, routeScope: "account", source: "upstream", sanitizedMessage: "upstream unavailable", retryAt: null, ...overrides };
}

/** A non-retryable provider call error. */
function nonRetryableError(overrides: Partial<ProviderCallError> = {}): ProviderCallError {
  return { statusCode: 400, kind: "invalid_request", retryable: false, routeScope: null, source: "client", sanitizedMessage: "bad request", retryAt: null, ...overrides };
}

describe("createStreamLifecycle", () => {
  test("starts with all flags false and not closed", () => {
    const lifecycle = createStreamLifecycle();
    expect(lifecycle.headersCommitted).toBe(false);
    expect(lifecycle.meaningfulOutput).toBe(false);
    expect(lifecycle.terminalSeen).toBe(false);
  });

  test("markHeadersCommitted sets the headersCommitted flag", () => {
    const lifecycle = createStreamLifecycle();
    lifecycle.markHeadersCommitted();
    expect(lifecycle.headersCommitted).toBe(true);
  });

  test("markMeaningfulOutput sets the meaningfulOutput flag", () => {
    const lifecycle = createStreamLifecycle();
    lifecycle.markMeaningfulOutput();
    expect(lifecycle.meaningfulOutput).toBe(true);
  });

  test("markTerminalSeen sets the terminalSeen flag", () => {
    const lifecycle = createStreamLifecycle();
    lifecycle.markTerminalSeen();
    expect(lifecycle.terminalSeen).toBe(true);
  });

  test("fires onClose exactly once on the first close", async () => {
    let closeCalls = 0;
    const lifecycle = createStreamLifecycle(() => { closeCalls += 1; });
    await lifecycle.close();
    await lifecycle.close();
    expect(closeCalls).toBe(1);
  });

  test("double close is idempotent and never throws", async () => {
    const lifecycle = createStreamLifecycle();
    await lifecycle.close();
    await expect(lifecycle.close()).resolves.toBeUndefined();
  });

  test("close without onClose resolves successfully", async () => {
    const lifecycle = createStreamLifecycle();
    await expect(lifecycle.close()).resolves.toBeUndefined();
  });

  test("onClose that throws is swallowed (non-fatal to the request)", async () => {
    const lifecycle = createStreamLifecycle(() => { throw new Error("cleanup failed"); });
    await expect(lifecycle.close()).resolves.toBeUndefined();
  });
});

describe("trackStream", () => {
  test("marks meaningful output on text_delta", async () => {
    const lifecycle = createStreamLifecycle();
    const events: StreamEvent[] = [
      { type: "message_start", id: "msg-1" },
      { type: "text_delta", text: "hello" },
    ];
    for await (const _event of trackStream(asyncIterableFrom(events), lifecycle)) { void _event; }
    expect(lifecycle.meaningfulOutput).toBe(true);
  });

  test("marks meaningful output on thinking_delta", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _event of trackStream(asyncIterableFrom([{ type: "thinking_delta", text: "thinking" }]), lifecycle)) { void _event; }
    expect(lifecycle.meaningfulOutput).toBe(true);
  });

  test("marks meaningful output on tool_call_start", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _event of trackStream(asyncIterableFrom([{ type: "tool_call_start", callId: "c1", name: "search" }]), lifecycle)) { void _event; }
    expect(lifecycle.meaningfulOutput).toBe(true);
  });

  test("marks meaningful output on tool_call_delta", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _event of trackStream(asyncIterableFrom([{ type: "tool_call_delta", callId: "c1", delta: "arg" }]), lifecycle)) { void _event; }
    expect(lifecycle.meaningfulOutput).toBe(true);
  });

  test("does not mark meaningful output on usage or ping events", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _event of trackStream(asyncIterableFrom([
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" } },
      { type: "message_start", id: "msg-1" },
    ]), lifecycle)) { void _event; }
    expect(lifecycle.meaningfulOutput).toBe(false);
  });

  test("marks terminalSeen on message_stop", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _event of trackStream(asyncIterableFrom([{ type: "message_stop", reason: "completed" }]), lifecycle)) { void _event; }
    expect(lifecycle.terminalSeen).toBe(true);
  });

  test("passes events through unmodified", async () => {
    const lifecycle = createStreamLifecycle();
    const input: StreamEvent[] = [
      { type: "message_start", id: "msg-1" },
      { type: "text_delta", text: "hello" },
      { type: "message_stop", reason: "completed" },
    ];
    const output: StreamEvent[] = [];
    for await (const event of trackStream(asyncIterableFrom(input), lifecycle)) output.push(event);
    expect(output).toEqual(input);
  });
});

describe("isProviderCallError", () => {
  test("returns true for a well-formed ProviderCallError object", () => {
    const error = retryableError();
    expect(isProviderCallError(error)).toBe(true);
  });

  test("returns true for an object with the right shape but extra fields", () => {
    const error = { ...retryableError(), extra: "ignored" };
    expect(isProviderCallError(error)).toBe(true);
  });

  test("returns false for a generic Error instance", () => {
    expect(isProviderCallError(new Error("boom"))).toBe(false);
  });

  test("returns false for a plain string", () => {
    expect(isProviderCallError("error string")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isProviderCallError(null)).toBe(false);
  });

  test("returns false for an object missing required fields", () => {
    expect(isProviderCallError({ kind: "internal_error" })).toBe(false);
    expect(isProviderCallError({ kind: "internal_error", sanitizedMessage: "msg" })).toBe(false);
    expect(isProviderCallError({ kind: 123, sanitizedMessage: "msg", retryable: true })).toBe(false);
  });
});

describe("toProviderCallError", () => {
  test("uses the caller's mapError when provided", () => {
    const mapped: ProviderCallError = { statusCode: 418, kind: "internal_error", retryable: false, routeScope: null, source: "internal", sanitizedMessage: "mapped", retryAt: null };
    const result = toProviderCallError(new Error("original"), () => mapped);
    expect(result).toBe(mapped);
  });

  test("converts an object with toProviderCallError() method", () => {
    const error = new StreamDecodeError("stream_truncated", "Stream ended early");
    const result = toProviderCallError(error);
    expect(result.kind).toBe("stream_truncated");
    expect(result.retryable).toBe(false);
    expect(result.routeScope).toBe("provider");
  });

  test("passes through an already-typed ProviderCallError", () => {
    const error = retryableError();
    const result = toProviderCallError(error);
    expect(result).toBe(error);
  });

  test("falls back to internal_error for a plain string", () => {
    const result = toProviderCallError("something went wrong");
    expect(result.kind).toBe("internal_error");
    expect(result.retryable).toBe(false);
    expect(result.routeScope).toBeNull();
    expect(result.source).toBe("internal");
  });

  test("falls back to internal_error for a generic Error", () => {
    const result = toProviderCallError(new Error("generic failure"));
    expect(result.kind).toBe("internal_error");
    expect(result.retryable).toBe(false);
    expect(result.sanitizedMessage).toContain("generic failure");
  });

  test("falls back to internal_error for null", () => {
    const result = toProviderCallError(null);
    expect(result.kind).toBe("internal_error");
    expect(result.retryable).toBe(false);
  });
});

describe("waitBeforeRetry", () => {
  test("throws client_aborted immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = retryableError();
    await expect(waitBeforeRetry(error, 0, controller.signal)).rejects.toMatchObject({ kind: "client_aborted" });
  });

  test("aborts mid-wait when the signal fires during the delay", async () => {
    const controller = new AbortController();
    const error: ProviderCallError = { statusCode: 503, kind: "provider_unavailable", retryable: true, routeScope: "account", source: "upstream", sanitizedMessage: "unavailable", retryAt: null };
    setTimeout(() => controller.abort(), 10);
    await expect(waitBeforeRetry(error, 0, controller.signal)).rejects.toMatchObject({ kind: "client_aborted" });
  });

  test("resolves after a bounded delay for a retryable error with no Retry-After", async () => {
    const controller = new AbortController();
    const error = retryableError();
    const start = Date.now();
    await waitBeforeRetry(error, 0, controller.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(3000);
  });

  test("honors a Retry-After timestamp in the near future", async () => {
    const controller = new AbortController();
    const nearFuture = new Date(Date.now() + 80).toISOString();
    const error: ProviderCallError = { statusCode: 429, kind: "provider_rate_limited", retryable: true, routeScope: "provider", source: "upstream", sanitizedMessage: "rate limited", retryAt: nearFuture };
    const start = Date.now();
    await waitBeforeRetry(error, 0, controller.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(5100);
  });

  test("caps the Retry-After delay to 5 seconds", async () => {
    const controller = new AbortController();
    const farFuture = new Date(Date.now() + 60_000).toISOString();
    const error: ProviderCallError = { statusCode: 429, kind: "provider_rate_limited", retryable: true, routeScope: "provider", source: "upstream", sanitizedMessage: "rate limited", retryAt: farFuture };
    const start = Date.now();
    await waitBeforeRetry(error, 0, controller.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5100);
  });

  test("ignores a Retry-After in the past and applies backoff instead", async () => {
    const controller = new AbortController();
    const past = new Date(Date.now() - 1000).toISOString();
    const error: ProviderCallError = { statusCode: 503, kind: "provider_unavailable", retryable: true, routeScope: "account", source: "upstream", sanitizedMessage: "unavailable", retryAt: past };
    const start = Date.now();
    await waitBeforeRetry(error, 0, controller.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("recoverCall", () => {
  test("returns the non-stream output on the first successful attempt", async () => {
    const cleanup = createCleanupStack();
    let attempts = 0;
    const result = await recoverCall({
      attempt: async () => { attempts += 1; return nonStreamOutput({ ok: true }); },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
    });
    expect(result.mode).toBe("non_stream");
    expect(attempts).toBe(1);
  });

  test("retries a pre-stream failure when shouldRetry permits", async () => {
    const cleanup = createCleanupStack();
    let attempts = 0;
    const result = await recoverCall({
      attempt: async () => {
        attempts += 1;
        if (attempts < 2) throw retryableError();
        return nonStreamOutput({ ok: true });
      },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
      waitBeforeRetry: async () => {},
    });
    expect(result.mode).toBe("non_stream");
    expect(attempts).toBe(2);
  });

  test("does not retry when shouldRetry overrides to false", async () => {
    const cleanup = createCleanupStack();
    let attempts = 0;
    await expect(recoverCall({
      attempt: async () => { attempts += 1; throw retryableError(); },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
      shouldRetry: () => false,
      waitBeforeRetry: async () => {},
    })).rejects.toMatchObject({ kind: "provider_unavailable" });
    expect(attempts).toBe(1);
  });

  test("throws the last error after exhausting maxAttempts", async () => {
    const cleanup = createCleanupStack();
    let attempts = 0;
    await expect(recoverCall({
      attempt: async () => { attempts += 1; throw retryableError({ sanitizedMessage: `attempt ${attempts}` }); },
      maxAttempts: 2,
      signal: new AbortController().signal,
      cleanup,
      waitBeforeRetry: async () => {},
    })).rejects.toMatchObject({ kind: "provider_unavailable" });
    expect(attempts).toBe(2);
  });

  test("does not retry a non-retryable error", async () => {
    const cleanup = createCleanupStack();
    let attempts = 0;
    await expect(recoverCall({
      attempt: async () => { attempts += 1; throw nonRetryableError(); },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
      waitBeforeRetry: async () => {},
    })).rejects.toMatchObject({ kind: "invalid_request" });
    expect(attempts).toBe(1);
  });

  test("calls onFailure per failed attempt before retrying", async () => {
    const cleanup = createCleanupStack();
    const failures: ProviderCallError[] = [];
    let attempts = 0;
    await recoverCall({
      attempt: async () => {
        attempts += 1;
        if (attempts < 2) throw retryableError({ sanitizedMessage: `fail ${attempts}` });
        return nonStreamOutput();
      },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
      onFailure: (error) => { failures.push(error); },
      waitBeforeRetry: async () => {},
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.sanitizedMessage).toContain("fail 1");
  });

  test("aborts immediately with client_aborted when signal is already aborted", async () => {
    const cleanup = createCleanupStack();
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    await expect(recoverCall({
      attempt: async () => { attempts += 1; return nonStreamOutput(); },
      maxAttempts: 3,
      signal: controller.signal,
      cleanup,
    })).rejects.toMatchObject({ kind: "client_aborted" });
    expect(attempts).toBe(0);
  });

  test("runs the cleanup stack exactly once on success", async () => {
    let cleanupRuns = 0;
    const cleanup = createCleanupStack();
    cleanup.add({ release: async () => { cleanupRuns += 1; } });
    await recoverCall({
      attempt: async () => nonStreamOutput(),
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
    });
    await cleanup.run();
    expect(cleanupRuns).toBe(1);
  });

  test("runs the cleanup stack exactly once on final failure", async () => {
    let cleanupRuns = 0;
    const cleanup = createCleanupStack();
    cleanup.add({ release: async () => { cleanupRuns += 1; } });
    await expect(recoverCall({
      attempt: async () => { throw retryableError(); },
      maxAttempts: 1,
      signal: new AbortController().signal,
      cleanup,
      waitBeforeRetry: async () => {},
    })).rejects.toMatchObject({ kind: "provider_unavailable" });
    expect(cleanupRuns).toBe(1);
  });

  test("stream output: rejects mid-stream retry after meaningful output", async () => {
    const cleanup = createCleanupStack();
    const lifecycle = createStreamLifecycle();
    let attempts = 0;
    const result = await recoverCall({
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) {
          return streamFromIterable(asyncGeneratorThrowAfterMeaningful());
        }
        return nonStreamOutput();
      },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
      lifecycle,
      shouldRetry: () => true,
      waitBeforeRetry: async () => {},
    });
    expect(result.mode).toBe("stream");
    if (result.mode === "stream") {
      const events: StreamEvent[] = [];
      await expect(
        (async () => {
          for await (const event of result.events) events.push(event);
        })(),
      ).rejects.toMatchObject({ kind: "provider_unavailable" });
      expect(events.some((e) => e.type === "text_delta")).toBe(true);
      expect(lifecycle.meaningfulOutput).toBe(true);
      expect(attempts).toBe(1);
    }
  });

  test("stream output: retries when failure occurs before meaningful output", async () => {
    const cleanup = createCleanupStack();
    const lifecycle = createStreamLifecycle();
    let attempts = 0;
    const result = await recoverCall({
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) {
          return streamFromIterable(asyncGeneratorThrowBeforeMeaningful());
        }
        return streamOutput([
          { type: "message_start", id: "msg-1" },
          { type: "text_delta", text: "hello" },
          { type: "message_stop", reason: "completed" },
        ]);
      },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
      lifecycle,
      shouldRetry: () => true,
      waitBeforeRetry: async () => {},
    });
    expect(result.mode).toBe("stream");
    if (result.mode === "stream") {
      const events: StreamEvent[] = [];
      for await (const event of result.events) events.push(event);
      expect(events.some((e) => e.type === "text_delta")).toBe(true);
      expect(attempts).toBe(2);
    }
  });

  test("stream output: does not retry after terminal event seen", async () => {
    const cleanup = createCleanupStack();
    const lifecycle = createStreamLifecycle();
    let attempts = 0;
    const result = await recoverCall({
      attempt: async () => {
        attempts += 1;
        return streamFromIterable(asyncGeneratorThrowAfterTerminal());
      },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
      lifecycle,
      shouldRetry: () => true,
      waitBeforeRetry: async () => {},
    });
    expect(result.mode).toBe("stream");
    if (result.mode === "stream") {
      const events: StreamEvent[] = [];
      for await (const event of result.events) events.push(event);
      // The terminal event completes the stream; the post-terminal throw
      // is never reached because recoverableEvents returns after the terminal.
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
      expect(lifecycle.terminalSeen).toBe(true);
      expect(attempts).toBe(1);
    }
  });

  test("stream output: cleans up exactly once on terminal completion", async () => {
    let cleanupRuns = 0;
    const cleanup = createCleanupStack();
    cleanup.add({ release: async () => { cleanupRuns += 1; } });
    const result = await recoverCall({
      attempt: async () => streamOutput([
        { type: "message_start", id: "msg-1" },
        { type: "text_delta", text: "done" },
        { type: "message_stop", reason: "completed" },
      ]),
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
    });
    if (result.mode === "stream") {
      for await (const _event of result.events) { void _event; }
    }
    expect(cleanupRuns).toBe(1);
  });

  test("uses the custom mapError to convert thrown values", async () => {
    const cleanup = createCleanupStack();
    const mapped: ProviderCallError = { statusCode: 502, kind: "provider_protocol_error", retryable: false, routeScope: "provider", source: "upstream", sanitizedMessage: "mapped protocol error", retryAt: null };
    await expect(recoverCall({
      attempt: async () => { throw new Error("raw upstream error"); },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
      mapError: () => mapped,
      shouldRetry: () => false,
      waitBeforeRetry: async () => {},
    })).rejects.toBe(mapped);
  });
});

describe("isMeaningfulEvent (via trackStream side effects)", () => {
  test("text_delta is meaningful", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _e of trackStream(asyncIterableFrom([{ type: "text_delta", text: "x" }]), lifecycle)) { void _e; }
    expect(lifecycle.meaningfulOutput).toBe(true);
  });

  test("thinking_delta is meaningful", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _e of trackStream(asyncIterableFrom([{ type: "thinking_delta", text: "x" }]), lifecycle)) { void _e; }
    expect(lifecycle.meaningfulOutput).toBe(true);
  });

  test("tool_call_start is meaningful", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _e of trackStream(asyncIterableFrom([{ type: "tool_call_start", callId: "c1", name: "n" }]), lifecycle)) { void _e; }
    expect(lifecycle.meaningfulOutput).toBe(true);
  });

  test("tool_call_delta is meaningful", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _e of trackStream(asyncIterableFrom([{ type: "tool_call_delta", callId: "c1", delta: "d" }]), lifecycle)) { void _e; }
    expect(lifecycle.meaningfulOutput).toBe(true);
  });

  test("message_start is NOT meaningful", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _e of trackStream(asyncIterableFrom([{ type: "message_start", id: "m1" }]), lifecycle)) { void _e; }
    expect(lifecycle.meaningfulOutput).toBe(false);
  });

  test("usage is NOT meaningful", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _e of trackStream(asyncIterableFrom([{ type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" } }]), lifecycle)) { void _e; }
    expect(lifecycle.meaningfulOutput).toBe(false);
  });

  test("tool_call_end is NOT meaningful", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _e of trackStream(asyncIterableFrom([{ type: "tool_call_end", callId: "c1" }]), lifecycle)) { void _e; }
    expect(lifecycle.meaningfulOutput).toBe(false);
  });

  test("message_stop is NOT meaningful (it is terminal, not meaningful)", async () => {
    const lifecycle = createStreamLifecycle();
    for await (const _e of trackStream(asyncIterableFrom([{ type: "message_stop", reason: "completed" }]), lifecycle)) { void _e; }
    expect(lifecycle.meaningfulOutput).toBe(false);
    expect(lifecycle.terminalSeen).toBe(true);
  });
});

// -------------------------------------------------------------- helpers

/** Wraps a plain array as an async iterable. */
function asyncIterableFrom(events: readonly StreamEvent[]): AsyncIterable<StreamEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      let i = 0;
      return {
        next(): Promise<IteratorResult<StreamEvent>> {
          if (i < events.length) return Promise.resolve({ value: events[i++]!, done: false });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/** A stream that yields meaningful output, then throws (post-meaningful failure). */
async function* asyncGeneratorThrowAfterMeaningful(): AsyncGenerator<StreamEvent> {
  yield { type: "text_delta", text: "partial output" };
  throw retryableError({ sanitizedMessage: "stream failed after output" });
}

/** A stream that throws before yielding any meaningful output. */
async function* asyncGeneratorThrowBeforeMeaningful(): AsyncGenerator<StreamEvent> {
  yield { type: "message_start", id: "msg-1" };
  throw retryableError({ sanitizedMessage: "stream failed before output" });
}

/** A stream that yields a terminal event, then throws (post-terminal failure). */
async function* asyncGeneratorThrowAfterTerminal(): AsyncGenerator<StreamEvent> {
  yield { type: "message_stop", reason: "completed" };
  throw retryableError({ sanitizedMessage: "stream failed after terminal" });
}
