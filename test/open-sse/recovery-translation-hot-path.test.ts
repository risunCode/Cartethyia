import { afterEach, describe, expect, test, vi } from "bun:test";
import type {
  CacheIntent,
  CleanupStack,
  NormalizedMessage,
  ProviderCallError,
  ProviderOutput,
  ProxyRequest,
  StreamEvent,
} from "../../src/application/contracts";
import { createCleanupStack } from "../../src/application/contracts";
import { applyCachePlan, buildCachePlan, looksStableText } from "../../src/application/cache";
import {
  createStreamLifecycle,
  isProviderCallError,
  recoverCall,
  toProviderCallError,
  trackStream,
  waitBeforeRetry,
} from "../../src/open-sse/handlers/recovery";
import { boundedTranslationDiagnostics, type TranslationDiagnosticInput } from "../../src/open-sse/translate/diagnostics";
import { getCacheIntent, hasCacheBreakpoint } from "../../src/open-sse/translate/features/cache";
import {
  applyOpenAIChatCacheBreakpoint,
  applyOpenAIResponsesCacheBreakpoint,
  stripOpenAIPromptCacheMetadata,
} from "../../src/open-sse/translate/policy/cache";
import { StreamDecodeError } from "../../src/open-sse/translate/errors";

const requestLimits = {
  maxBodyBytes: 10_000_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};

function providerRequest(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: "gpt-5.6-luna",
    messages: [],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits: requestLimits,
    ...overrides,
  };
}

function textMessage(role: NormalizedMessage["role"], text: string, cacheControl?: "ephemeral"): NormalizedMessage {
  return { role, content: [{ type: "text", text, ...(cacheControl === undefined ? {} : { cacheControl }) }] };
}

function stream(...events: StreamEvent[]): AsyncIterable<StreamEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function streamOutput(events: AsyncIterable<StreamEvent>): ProviderOutput {
  return { mode: "stream", events };
}

function failure(overrides: Partial<ProviderCallError> = {}): ProviderCallError {
  return {
    statusCode: 503,
    kind: "provider_unavailable",
    retryable: true,
    routeScope: "provider",
    source: "upstream",
    sanitizedMessage: "upstream unavailable",
    retryAt: null,
    ...overrides,
  };
}

function cleanupCounter(): { readonly cleanup: CleanupStack; readonly count: () => number } {
  let released = 0;
  const cleanup = createCleanupStack();
  cleanup.add({ release: async () => { released += 1; } });
  return { cleanup, count: () => released };
}

async function consume(output: ProviderOutput): Promise<StreamEvent[]> {
  if (output.mode !== "stream") throw new Error("expected stream output");
  const events: StreamEvent[] = [];
  for await (const event of output.events) events.push(event);
  return events;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("recovery lifecycle and reliability hot paths", () => {
  test("closes idempotently and swallows a cleanup-side failure", async () => {
    let closeCalls = 0;
    const lifecycle = createStreamLifecycle(async () => {
      closeCalls += 1;
      throw new Error("cleanup detail should not escape");
    });
    lifecycle.markHeadersCommitted();
    lifecycle.markMeaningfulOutput();
    lifecycle.markTerminalSeen();

    await Promise.all([lifecycle.close(), lifecycle.close(), lifecycle.close()]);

    expect(closeCalls).toBe(1);
    expect(lifecycle.headersCommitted).toBe(true);
    expect(lifecycle.meaningfulOutput).toBe(true);
    expect(lifecycle.terminalSeen).toBe(true);
  });

  test("tracks semantic and terminal events while passing every event through", async () => {
    const lifecycle = createStreamLifecycle();
    const seen: StreamEvent[] = [];
    for await (const event of trackStream(stream(
      { type: "message_start", id: "track-1" },
      { type: "text_delta", text: "hello" },
      { type: "message_stop", reason: "error" },
    ), lifecycle)) {
      seen.push(event);
    }

    expect(seen).toEqual([
      { type: "message_start", id: "track-1" },
      { type: "text_delta", text: "hello" },
      { type: "message_stop", reason: "error" },
    ]);
    expect(lifecycle.meaningfulOutput).toBe(true);
    expect(lifecycle.terminalSeen).toBe(true);
  });

  test("maps typed, structural, custom-mapped, and unknown failures safely", () => {
    const typed = new StreamDecodeError("provider_protocol_error", "Authorization: Bearer should-not-leak");
    const typedMapped = toProviderCallError(typed);
    expect(typedMapped.kind).toBe("provider_protocol_error");
    expect(typedMapped.sanitizedMessage).not.toContain("should-not-leak");

    const structural = failure({ sanitizedMessage: "already safe" });
    expect(toProviderCallError(structural)).toBe(structural);
    expect(isProviderCallError(structural)).toBe(true);
    expect(isProviderCallError({ kind: "provider_unavailable" })).toBe(false);
    expect(isProviderCallError(null)).toBe(false);

    const mapped = failure({ kind: "authentication_failed", retryable: false });
    expect(toProviderCallError("ignored", () => mapped)).toBe(mapped);

    const unknown = toProviderCallError("token=top-secret");
    expect(unknown).toMatchObject({ kind: "internal_error", retryable: false, routeScope: null });
    expect(unknown.sanitizedMessage).not.toContain("top-secret");
  });

  test("uses bounded retry-at timestamps and deterministic exponential backoff", async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-08-12T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const signal = new AbortController().signal;

    let retryAtDone = false;
    const retryAtWait = waitBeforeRetry(failure({ retryAt: "2026-08-12T00:01:00.000Z" }), 1, signal).then(() => { retryAtDone = true; });
    await Promise.resolve();
    vi.advanceTimersByTime(4_999);
    await Promise.resolve();
    expect(retryAtDone).toBe(false);
    vi.advanceTimersByTime(1);
    await retryAtWait;
    expect(retryAtDone).toBe(true);

    let backoffDone = false;
    const backoffWait = waitBeforeRetry(failure({ retryAt: "not-a-date" }), 2, signal).then(() => { backoffDone = true; });
    vi.advanceTimersByTime(199);
    await Promise.resolve();
    expect(backoffDone).toBe(false);
    vi.advanceTimersByTime(1);
    await backoffWait;
    expect(backoffDone).toBe(true);
  });

  test("rejects immediately or during retry delay when the caller aborts", async () => {
    const beforeWait = new AbortController();
    beforeWait.abort();
    await expect(waitBeforeRetry(failure(), 1, beforeWait.signal)).rejects.toMatchObject({ kind: "client_aborted" });

    const duringWait = new AbortController();
    const pending = waitBeforeRetry(failure(), 1, duringWait.signal);
    duringWait.abort();
    await expect(pending).rejects.toMatchObject({ kind: "client_aborted" });
  });

  test("returns non-stream output and releases cleanup exactly once", async () => {
    const counter = cleanupCounter();
    const output = await recoverCall({
      attempt: async () => ({ mode: "non_stream", body: { answer: "ok" } }),
      maxAttempts: 1,
      signal: new AbortController().signal,
      cleanup: counter.cleanup,
    });

    expect(output).toEqual({ mode: "non_stream", body: { answer: "ok" } });
    await counter.cleanup.run();
    expect(counter.count()).toBe(1);
  });

  test("bounds pre-stream retries and reports every failed attempt before final throw", async () => {
    const counter = cleanupCounter();
    const attemptIndexes: number[] = [];
    const failureIndexes: number[] = [];
    const retryIndexes: number[] = [];

    await expect(recoverCall({
      attempt: async (index) => {
        attemptIndexes.push(index);
        throw failure({ sanitizedMessage: `failure-${index}` });
      },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup: counter.cleanup,
      onFailure: async (_error, index) => { failureIndexes.push(index); },
      waitBeforeRetry: async (_error, retryIndex) => { retryIndexes.push(retryIndex); },
    })).rejects.toMatchObject({ kind: "provider_unavailable", sanitizedMessage: "failure-2" });

    expect(attemptIndexes).toEqual([0, 1, 2]);
    expect(failureIndexes).toEqual([0, 1, 2]);
    expect(retryIndexes).toEqual([1, 2]);
    expect(counter.count()).toBe(1);
  });

  test("does not retry a non-retryable terminal error and cleans up once", async () => {
    const counter = cleanupCounter();
    const lifecycle = createStreamLifecycle();
    let attempts = 0;
    const output = await recoverCall({
      attempt: async () => {
        attempts += 1;
        return streamOutput(stream(
          { type: "message_start", id: "terminal" },
          { type: "message_stop", reason: "error", error: { statusCode: 400, kind: "invalid_request", message: "bad input", retryAt: null } },
        ));
      },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup: counter.cleanup,
      lifecycle,
      waitBeforeRetry: async () => { throw new Error("non-retryable terminal stream must not retry"); },
    });

    expect(await consume(output)).toEqual([
      { type: "message_start", id: "terminal" },
      { type: "message_stop", reason: "error", error: { statusCode: 400, kind: "invalid_request", message: "bad input", retryAt: null } },
    ]);
    expect(attempts).toBe(1);
    expect(lifecycle.terminalSeen).toBe(true);
    expect(counter.count()).toBe(1);
  });

  test("retries a provider overload terminal before semantic output", async () => {
    const counter = cleanupCounter();
    let attempts = 0;
    const output = await recoverCall({
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) {
          return streamOutput(stream(
            { type: "message_start", id: "overloaded" },
            { type: "message_stop", reason: "error", error: { statusCode: null, kind: "provider_unavailable", message: "Our servers are currently overloaded. Please try again later.", retryAt: null } },
          ));
        }
        return streamOutput(stream(
          { type: "message_start", id: "recovered" },
          { type: "text_delta", text: "ok" },
          { type: "message_stop", reason: "completed" },
        ));
      },
      maxAttempts: 2,
      signal: new AbortController().signal,
      cleanup: counter.cleanup,
      waitBeforeRetry: async () => {},
    });

    expect(await consume(output)).toEqual([
      { type: "message_start", id: "recovered" },
      { type: "text_delta", text: "ok" },
      { type: "message_stop", reason: "completed" },
    ]);
    expect(attempts).toBe(2);
    expect(counter.count()).toBe(1);
  });

  test("retries a naturally truncated opening stream and emits only the recovered attempt", async () => {
    const counter = cleanupCounter();
    const failures: string[] = [];
    let attempts = 0;
    const output = await recoverCall({
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) return streamOutput(stream({ type: "message_start", id: "truncated" }));
        return streamOutput(stream(
          { type: "message_start", id: "recovered" },
          { type: "text_delta", text: "complete" },
          { type: "message_stop", reason: "completed" },
        ));
      },
      maxAttempts: 2,
      signal: new AbortController().signal,
      cleanup: counter.cleanup,
      onFailure: async (error) => { failures.push(error.kind); },
      waitBeforeRetry: async () => {},
    });

    expect(await consume(output)).toEqual([
      { type: "message_start", id: "recovered" },
      { type: "text_delta", text: "complete" },
      { type: "message_stop", reason: "completed" },
    ]);
    expect(attempts).toBe(2);
    expect(failures).toEqual(["stream_truncated"]);
    expect(counter.count()).toBe(1);
  });

  test("does not retry a truncation after semantic output", async () => {
    const counter = cleanupCounter();
    let attempts = 0;
    const output = await recoverCall({
      attempt: async () => {
        attempts += 1;
        return streamOutput(stream(
          { type: "message_start", id: "partial" },
          { type: "text_delta", text: "visible" },
        ));
      },
      maxAttempts: 2,
      signal: new AbortController().signal,
      cleanup: counter.cleanup,
      waitBeforeRetry: async () => { throw new Error("semantic output must not retry"); },
    });

    await expect(consume(output)).rejects.toMatchObject({ kind: "stream_truncated" });
    expect(attempts).toBe(1);
    expect(counter.count()).toBe(1);
  });

  test("accepts provider usage after semantic output before terminal", async () => {
    const counter = cleanupCounter();
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" as const };
    const output = await recoverCall({
      attempt: async () => streamOutput(stream(
        { type: "message_start", id: "usage-after-text" },
        { type: "text_delta", text: "visible" },
        { type: "usage", usage },
        { type: "message_stop", reason: "completed" },
      )),
      maxAttempts: 2,
      signal: new AbortController().signal,
      cleanup: counter.cleanup,
      waitBeforeRetry: async () => { throw new Error("valid trailing usage must not retry"); },
    });
    expect(await consume(output)).toEqual([
      { type: "message_start", id: "usage-after-text" },
      { type: "text_delta", text: "visible" },
      { type: "usage", usage },
      { type: "message_stop", reason: "completed" },
    ]);
    expect(counter.count()).toBe(1);
  });

  test("rejects out-of-order and duplicate opening metadata as protocol failures", async () => {
    const cases: AsyncIterable<StreamEvent>[] = [
      stream(
        { type: "message_start", id: "order" },
        { type: "text_delta", text: "visible" },
        { type: "message_start", id: "late" },
      ),
      stream(
        { type: "message_start", id: "first" },
        { type: "message_start", id: "second" },
      ),
      stream({ type: "message_start", id: "x".repeat(4_097) }),
    ];

    for (const events of cases) {
      const counter = cleanupCounter();
      let attempts = 0;
      const output = await recoverCall({
        attempt: async () => {
          attempts += 1;
          return streamOutput(events);
        },
        maxAttempts: 2,
        signal: new AbortController().signal,
        cleanup: counter.cleanup,
        waitBeforeRetry: async () => { throw new Error("protocol failure must not retry"); },
      });

      await expect(consume(output)).rejects.toMatchObject({ kind: "provider_protocol_error" });
      expect(attempts).toBe(1);
      expect(counter.count()).toBe(1);
    }
  });

  test("fails if a stream retry returns non-stream output", async () => {
    const counter = cleanupCounter();
    let attempts = 0;
    const output = await recoverCall({
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) return streamOutput(stream({ type: "message_start", id: "first" }));
        return { mode: "non_stream", body: { answer: "wrong mode" } };
      },
      maxAttempts: 2,
      signal: new AbortController().signal,
      cleanup: counter.cleanup,
      waitBeforeRetry: async () => {},
    });

    await expect(consume(output)).rejects.toMatchObject({ kind: "provider_protocol_error" });
    expect(attempts).toBe(2);
    expect(counter.count()).toBe(1);
  });

  test("aborts an active stream before its next event and closes cleanup once", async () => {
    const controller = new AbortController();
    const counter = cleanupCounter();
    let attempts = 0;
    const output = await recoverCall({
      attempt: async () => {
        attempts += 1;
        return streamOutput((async function* () {
          yield { type: "message_start", id: "abort" };
          controller.abort();
          yield { type: "text_delta", text: "must not escape" };
        })());
      },
      maxAttempts: 2,
      signal: controller.signal,
      cleanup: counter.cleanup,
      waitBeforeRetry: async () => {},
    });

    await expect(consume(output)).rejects.toMatchObject({ kind: "client_aborted" });
    expect(attempts).toBe(1);
    expect(counter.count()).toBe(1);
  });

  test("runs cleanup when a consumer cancels before terminal output", async () => {
    const counter = cleanupCounter();
    let sourceClosed = 0;
    const output = await recoverCall({
      attempt: async () => streamOutput((async function* () {
        try {
          yield { type: "message_start", id: "cancel" };
          yield { type: "text_delta", text: "one" };
          yield { type: "message_stop", reason: "completed" };
        } finally {
          sourceClosed += 1;
        }
      })()),
      maxAttempts: 1,
      signal: new AbortController().signal,
      cleanup: counter.cleanup,
    });

    if (output.mode !== "stream") throw new Error("expected stream output");
    const seen: StreamEvent[] = [];
    for await (const event of output.events) {
      seen.push(event);
      break;
    }

    expect(seen).toEqual([{ type: "message_start", id: "cancel" }]);
    expect(sourceClosed).toBe(1);
    expect(counter.count()).toBe(1);
  });

  test("cleans up pre-aborted calls and zero-attempt calls without invoking the adapter", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const abortedCounter = cleanupCounter();
    let abortedAttempts = 0;
    await expect(recoverCall({
      attempt: async () => {
        abortedAttempts += 1;
        return { mode: "non_stream", body: {} };
      },
      maxAttempts: 1,
      signal: aborted.signal,
      cleanup: abortedCounter.cleanup,
    })).rejects.toMatchObject({ kind: "client_aborted" });
    expect(abortedAttempts).toBe(0);
    expect(abortedCounter.count()).toBe(1);

    const emptyCounter = cleanupCounter();
    let emptyAttempts = 0;
    await expect(recoverCall({
      attempt: async () => {
        emptyAttempts += 1;
        return { mode: "non_stream", body: {} };
      },
      maxAttempts: 0,
      signal: new AbortController().signal,
      cleanup: emptyCounter.cleanup,
    })).rejects.toMatchObject({ kind: "internal_error" });
    expect(emptyAttempts).toBe(0);
    expect(emptyCounter.count()).toBe(1);
  });
});

describe("cache intent and projection hot paths", () => {
  test("derives cache intent TTL from a native breakpoint and preserves explicit intent", () => {
    const noKey = providerRequest({ messages: [textMessage("user", "question")] });
    expect(getCacheIntent(noKey)).toBeNull();

    const keyWithoutBreakpoint = providerRequest({ cacheKey: "plain-key", messages: [textMessage("user", "question")] });
    expect(getCacheIntent(keyWithoutBreakpoint)).toEqual({
      key: "plain-key",
      stablePrefixFingerprint: null,
      affinityKey: null,
      policy: "automatic",
      ttl: null,
    });

    const marked = providerRequest({
      cacheKey: "marked-key",
      messages: [textMessage("system", "stable system", "ephemeral")],
    });
    expect(hasCacheBreakpoint(marked)).toBe(true);
    expect(getCacheIntent(marked)).toEqual({
      key: "marked-key",
      stablePrefixFingerprint: null,
      affinityKey: null,
      policy: "automatic",
      ttl: "provider-default",
    });

    const explicit: CacheIntent = {
      key: "explicit",
      stablePrefixFingerprint: "fingerprint",
      affinityKey: "caller",
      policy: "explicit",
      ttl: "30m",
    };
    const withExplicit = providerRequest({ cacheKey: "ignored", cacheIntent: explicit });
    expect(getCacheIntent(withExplicit)).toBe(explicit);
  });

  test("splits stable cache prefixes before volatile messages and marks only the safe projection", () => {
    const stable = "stable system guidance ".repeat(12);
    const volatile = `${stable}2026-08-12T00:00:00Z`;
    expect(looksStableText(stable)).toBe(true);
    expect(looksStableText(volatile)).toBe(false);
    expect(looksStableText("request UUID 123e4567-e89b-12d3-a456-426614174000")).toBe(false);
    expect(looksStableText("-----BEGIN PRIVATE KEY-----")).toBe(false);

    const request = providerRequest({
      messages: [
        textMessage("system", volatile),
        textMessage("user", "current question"),
      ],
    });
    const plan = buildCachePlan(request);
    expect(plan.hasStablePrefix).toBe(true);
    expect(plan.prefixEndMessageIndex).toBe(0);
    expect(plan.prefixEndBlockIndex).toBe(0);
    expect(plan.sections[0]?.stable).toBe(false);

    const projected = applyCachePlan(request, plan, "api_key:local");
    const systemContent = projected.messages[0]?.content ?? [];
    expect(systemContent).toHaveLength(2);
    expect(systemContent[0]?.cacheControl).toBe("ephemeral");
    expect(systemContent[0]?.text).toBe(stable.trimEnd());
    expect(systemContent[1]?.cacheControl).toBeUndefined();
    expect(systemContent[1]?.text).toContain("2026-08-12T00:00:00Z");
    expect(projected.cacheKey).toMatch(/^[0-9a-f]{16}$/);
    expect(projected.cacheIntent?.affinityKey).toBe("api_key:local");
    const projectedIntent = projected.cacheIntent;
    if (projectedIntent === undefined) throw new Error("cache intent should be derived");
    expect(getCacheIntent(projected)).toBe(projectedIntent);
    expect(hasCacheBreakpoint(projected)).toBe(true);

    const volatileOnly = providerRequest({ messages: [textMessage("user", "request 2026-08-12T00:00:00Z")] });
    const noPlan = buildCachePlan(volatileOnly);
    expect(noPlan.hasStablePrefix).toBe(false);
    expect(applyCachePlan(volatileOnly, noPlan)).toBe(volatileOnly);
  });

  test("projects OpenAI Chat and Responses breakpoints only when supported and requested", () => {
    const request = providerRequest({
      model: "gpt-5.6-luna",
      cacheKey: "cache-key",
      messages: [
        textMessage("system", "stable system", "ephemeral"),
        textMessage("user", "question"),
      ],
    });

    const stringPayload: Record<string, unknown> = {
      messages: [
        { role: "system", content: "stable system" },
        { role: "user", content: "question" },
      ],
    };
    applyOpenAIChatCacheBreakpoint(stringPayload, request);
    expect(stringPayload.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    expect(stringPayload.messages).toEqual([
      { role: "system", content: [{ type: "text", text: "stable system", prompt_cache_breakpoint: { mode: "explicit" } }] },
      { role: "user", content: "question" },
    ]);

    const arrayPayload: Record<string, unknown> = {
      messages: [{ role: "system", content: [{ type: "image_url" }, { type: "text", text: "stable system" }] }],
    };
    applyOpenAIChatCacheBreakpoint(arrayPayload, request);
    expect(arrayPayload.messages).toEqual([
      { role: "system", content: [{ type: "image_url" }, { type: "text", text: "stable system", prompt_cache_breakpoint: { mode: "explicit" } }] },
    ]);

    const itemsForMessage = (message: NormalizedMessage): readonly Record<string, unknown>[] => [
      { role: message.role, content: [{ type: "input_text", text: message.content[0]?.text ?? "" }] },
    ];
    const responsesPayload: Record<string, unknown> = {
      input: [
        { role: "system", content: "stable system" },
        { role: "user", content: "question" },
      ],
    };
    applyOpenAIResponsesCacheBreakpoint(responsesPayload, request, itemsForMessage);
    expect(responsesPayload.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    expect(responsesPayload.input).toEqual([
      { role: "system", content: [{ type: "input_text", text: "stable system", prompt_cache_breakpoint: { mode: "explicit" } }] },
      { role: "user", content: "question" },
    ]);

    const unsupported = { messages: [{ role: "system", content: "stable system" }] } as Record<string, unknown>;
    applyOpenAIChatCacheBreakpoint(unsupported, request, "gpt-5", false);
    expect(unsupported).toEqual({ messages: [{ role: "system", content: "stable system" }] });
  });

  test("removes explicit cache metadata recursively while preserving the stable key", () => {
    const payload: Record<string, unknown> = {
      prompt_cache_key: "keep-me",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      input: [
        { content: [{ type: "input_text", prompt_cache_breakpoint: { mode: "explicit" } }], nested: { prompt_cache_breakpoint: true } },
      ],
      messages: [
        { content: [{ type: "text", prompt_cache_breakpoint: { mode: "explicit" } }] },
      ],
      untouched: { value: 1 },
    };

    stripOpenAIPromptCacheMetadata(payload);

    expect(payload).toEqual({
      prompt_cache_key: "keep-me",
      input: [{ content: [{ type: "input_text" }], nested: {} }],
      messages: [{ content: [{ type: "text" }] }],
      untouched: { value: 1 },
    });
  });
});

describe("secret-free diagnostics policy", () => {
  test("deduplicates, bounds, and sanitizes diagnostic metadata without payload secrets", () => {
    const inputs: TranslationDiagnosticInput[] = [
      {
        stage: "policy",
        sourceFormat: "untrusted-format",
        targetSurface: "openai-chat",
        fieldCategory: "field-".repeat(20),
        action: "adapted",
        reason: "Bearer super-secret-token",
      },
      {
        stage: "policy",
        sourceFormat: "untrusted-format",
        targetSurface: "openai-chat",
        fieldCategory: "field-".repeat(20),
        action: "adapted",
        reason: "Bearer super-secret-token",
      },
      {
        stage: "request",
        sourceFormat: "openai-chat",
        targetSurface: "openai-responses",
        fieldCategory: "credentials",
        action: "dropped",
        reason: "token: top-secret-value\u0000",
      },
      {
        stage: "response",
        sourceFormat: "openai-chat",
        targetSurface: "openai-chat",
        fieldCategory: "body",
        action: "fallback",
        reason: "structured {\"password\":\"hidden\"}",
      },
    ];

    const diagnostics = boundedTranslationDiagnostics(inputs);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0]?.sourceFormat).toBe("unknown");
    expect(diagnostics[0]?.fieldCategory.length).toBeLessThanOrEqual(64);
    expect(diagnostics[0]?.reason).toBe("bearer [redacted]");
    expect(diagnostics[1]?.reason).toBe("token [redacted]");
    expect(diagnostics[2]?.reason).toBe("redacted structured detail");
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("top-secret-value");
    expect(serialized).not.toContain("hidden");
  });
});
