import { describe, expect, test } from "bun:test";
import { createCleanupStack, type CleanupStack, type ProviderOutput, type StreamEvent } from "../../src/application/contracts";
import { recoverCall } from "../../src/open-sse/handlers/recovery";
import { ProviderAdapterError } from "../../src/open-sse/transport/errors";

function stream(...events: StreamEvent[]): AsyncIterable<StreamEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function cleanupCounter(): { readonly cleanup: CleanupStack; readonly count: () => number } {
  let released = 0;
  const cleanup = createCleanupStack();
  cleanup.add({ release: async () => { released += 1; } });
  return { cleanup, count: () => released };
}

function retryableFailure(): ProviderAdapterError {
  return new ProviderAdapterError({ kind: "provider_unavailable", message: "upstream unavailable", retryable: true, routeScope: "provider" });
}

async function consume(output: ProviderOutput): Promise<StreamEvent[]> {
  if (output.mode !== "stream") throw new Error("expected stream output");
  const events: StreamEvent[] = [];
  for await (const event of output.events) events.push(event);
  return events;
}

describe("retry-safe stream recovery", () => {
  test("discards failed opening metadata and emits one start on retry", async () => {
    let attempts = 0;
    const lifecycle = await recoverCall({
      attempt: async (): Promise<ProviderOutput> => {
        attempts += 1;
        if (attempts === 1) {
          return {
            mode: "stream",
            events: (async function* () {
              yield { type: "message_start", id: "failed" };
              throw retryableFailure();
            })(),
          };
        }
        return { mode: "stream", events: stream({ type: "message_start", id: "recovered" }, { type: "text_delta", text: "ok" }, { type: "message_stop", reason: "completed" }) };
      },
      maxAttempts: 2,
      signal: new AbortController().signal,
      cleanup: cleanupCounter().cleanup,
      waitBeforeRetry: async () => {},
    });
    const events = await consume(lifecycle);
    expect(attempts).toBe(2);
    expect(events).toEqual([
      { type: "message_start", id: "recovered" },
      { type: "text_delta", text: "ok" },
      { type: "message_stop", reason: "completed" },
    ]);
  });

  test("flushes buffered usage and opening metadata exactly once before semantic output", async () => {
    let attempts = 0;
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" as const };
    const counter = cleanupCounter();
    const output = await recoverCall({
      attempt: async (): Promise<ProviderOutput> => {
        attempts += 1;
        if (attempts === 1) {
          return {
            mode: "stream",
            events: (async function* () {
              yield { type: "message_start", id: "failed" };
              yield { type: "usage", usage };
              throw retryableFailure();
            })(),
          };
        }
        return {
          mode: "stream",
          events: stream({ type: "message_start", id: "recovered" }, { type: "usage", usage }, { type: "text_delta", text: "ok" }, { type: "message_stop", reason: "completed" }),
        };
      },
      maxAttempts: 2,
      signal: new AbortController().signal,
      cleanup: counter.cleanup,
      waitBeforeRetry: async () => {},
    });
    expect(await consume(output)).toEqual([
      { type: "message_start", id: "recovered" },
      { type: "usage", usage },
      { type: "text_delta", text: "ok" },
      { type: "message_stop", reason: "completed" },
    ]);
    expect(counter.count()).toBe(1);
  });

  test("does not retry after text output and cleans up once", async () => {
    let attempts = 0;
    const counter = cleanupCounter();
    const output = await recoverCall({
      attempt: async (): Promise<ProviderOutput> => {
        attempts += 1;
        return {
          mode: "stream",
          events: (async function* () {
            yield { type: "message_start", id: "first" };
            yield { type: "text_delta", text: "partial" };
            throw retryableFailure();
          })(),
        };
      },
      maxAttempts: 2,
      signal: new AbortController().signal,
      cleanup: counter.cleanup,
      waitBeforeRetry: async () => {},
    });
    const seen: StreamEvent[] = [];
    let failure: unknown = null;
    try {
      for await (const event of (output.mode === "stream" ? output.events : stream())) seen.push(event);
    } catch (error) {
      failure = error;
    }
    expect(seen).toEqual([{ type: "message_start", id: "first" }, { type: "text_delta", text: "partial" }]);
    expect(attempts).toBe(1);
    expect((failure as { kind?: string } | null)?.kind).toBe("provider_unavailable");
    expect(counter.count()).toBe(1);
  });

  test("treats malformed and oversized opening buffers as terminal protocol failures", async () => {
    const oversized: StreamEvent[] = Array.from({ length: 9 }, (): StreamEvent => ({ type: "usage", usage: { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" } }));
    const cases: StreamEvent[][] = [
      [{ type: "not_a_stream_event" } as unknown as StreamEvent],
      oversized,
    ];
    for (const events of cases) {
      let attempts = 0;
      const counter = cleanupCounter();
      const output = await recoverCall({
        attempt: async (): Promise<ProviderOutput> => {
          attempts += 1;
          return { mode: "stream", events: stream(...events) };
        },
        maxAttempts: 2,
        signal: new AbortController().signal,
        cleanup: counter.cleanup,
        waitBeforeRetry: async () => {},
      });
      let failure: unknown = null;
      try {
        await consume(output);
      } catch (error) {
        failure = error;
      }
      expect((failure as { kind?: string } | null)?.kind).toBe("provider_protocol_error");
      expect(attempts).toBe(1);
      expect(counter.count()).toBe(1);
    }
  });

  test("client abort during recovery prevents the next attempt", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const counter = cleanupCounter();
    const output = await recoverCall({
      attempt: async (): Promise<ProviderOutput> => {
        attempts += 1;
        return { mode: "stream", events: (async function* () { throw retryableFailure(); })() };
      },
      maxAttempts: 2,
      signal: controller.signal,
      cleanup: counter.cleanup,
      waitBeforeRetry: async () => { controller.abort(); },
    });
    let failure: unknown = null;
    try {
      await consume(output);
    } catch (error) {
      failure = error;
    }
    expect((failure as { kind?: string } | null)?.kind).toBe("client_aborted");
    expect(attempts).toBe(1);
    expect(counter.count()).toBe(1);
  });
});
