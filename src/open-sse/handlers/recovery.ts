import type { ProviderCallError } from "../../application/contracts";
import { sanitizeMessage, type CleanupStack, deriveErrorSource } from "../../application/contracts";
import type { ProviderOutput } from "../../application/contracts";
import { isTerminalEvent, type StreamLifecycle, type StreamEvent } from "../../application/contracts";
import { isRecord } from "../../application/protocols";
import { StreamDecodeError } from "../translate/errors";

/**
 * Recovery and lifecycle helpers: `recoverCall` retries provider attempts
 * only before meaningful output has been emitted, tracks stream lifecycle
 * state, and releases the cleanup stack exactly once at the final outcome
 * (success, final failure, stream end, or abort). Retry policy, candidate
 * selection, and health/switch recording are wired by the caller; this
 * module owns the retry mechanics only.
 */

// ---------------------------------------------------------------- lifecycle

/** Mutable implementation of the application `StreamLifecycle` contract. */
export interface StreamLifecycleController extends StreamLifecycle {
  markHeadersCommitted(): void;
  markMeaningfulOutput(): void;
  markTerminalSeen(): void;
}

/**
 * Creates the stream lifecycle state. `onClose` (e.g. running the cleanup
 * stack) fires at most once, on the first `close()` call; close is
 * idempotent afterwards and never throws.
 */
export function createStreamLifecycle(onClose?: () => void | Promise<void>): StreamLifecycleController {
  let headersCommitted = false;
  let meaningfulOutput = false;
  let terminalSeen = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  return {
    get headersCommitted(): boolean {
      return headersCommitted;
    },
    get meaningfulOutput(): boolean {
      return meaningfulOutput;
    },
    get terminalSeen(): boolean {
      return terminalSeen;
    },
    markHeadersCommitted(): void {
      headersCommitted = true;
    },
    markMeaningfulOutput(): void {
      meaningfulOutput = true;
    },
    markTerminalSeen(): void {
      terminalSeen = true;
    },
    close(): Promise<void> {
      if (closed) return closePromise ?? Promise.resolve();
      closed = true;
      closePromise = Promise.resolve()
        .then(() => onClose?.())
        .catch(() => {
          // close-side cleanup failures are non-fatal to the request
        });
      return closePromise;
    },
  };
}

const MAX_PRE_CONTENT_EVENTS = 8;
const MAX_PRE_CONTENT_BYTES = 16 * 1024;
const MAX_MESSAGE_START_ID_LENGTH = 4_096;

type StreamEventClass = "pre_content" | "semantic" | "terminal";

interface ClassifiedStreamEvent {
  readonly event: StreamEvent;
  readonly kind: StreamEventClass;
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isProviderUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isFiniteNumberOrNull(value.inputTokens) || !isFiniteNumberOrNull(value.outputTokens) || !isFiniteNumberOrNull(value.totalTokens)) return false;
  if (!isFiniteNumberOrNull(value.cacheReadTokens) || !isFiniteNumberOrNull(value.cacheWriteTokens)) return false;
  if (value.reasoningTokens !== undefined && !isFiniteNumberOrNull(value.reasoningTokens)) return false;
  return value.source === "provider" || value.source === "tokenizer" || value.source === "unknown";
}

function isValidStreamEvent(value: unknown): value is StreamEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "message_start":
      return typeof value.id === "string" && value.id.length <= MAX_MESSAGE_START_ID_LENGTH;
    case "thinking_delta":
    case "text_delta":
    case "compaction_delta":
      return typeof value.text === "string";
    case "tool_call_start":
      return typeof value.callId === "string" && typeof value.name === "string";
    case "tool_call_delta":
      return typeof value.callId === "string" && typeof value.delta === "string";
    case "tool_call_end":
      return typeof value.callId === "string";
    case "server_tool_result":
      return isRecord(value.block);
    case "native_block_start":
      return typeof value.index === "number" && Number.isFinite(value.index) && isRecord(value.block);
    case "native_block_delta":
      return typeof value.index === "number" && Number.isFinite(value.index) && isRecord(value.delta);
    case "native_block_stop":
      return typeof value.index === "number" && Number.isFinite(value.index);
    case "context_item":
      return (value.phase === "added" || value.phase === "done")
        && typeof value.outputIndex === "number"
        && Number.isFinite(value.outputIndex)
        && isRecord(value.item);
    case "compaction_start":
    case "compaction_stop":
      return true;
    case "usage":
      return isProviderUsage(value.usage);
    case "message_stop":
      return (value.reason === "completed"
        || value.reason === "length"
        || value.reason === "tool_call"
        || value.reason === "content_filter"
        || value.reason === "compaction"
        || value.reason === "pause_turn"
        || value.reason === "error")
        && (value.error === undefined || isRecord(value.error));
    default:
      return false;
  }
}

function classifyStreamEvent(value: unknown): ClassifiedStreamEvent | null {
  if (!isValidStreamEvent(value)) return null;
  if (value.type === "message_start" || value.type === "usage") return { event: value, kind: "pre_content" };
  if (isTerminalEvent(value)) return { event: value, kind: "terminal" };
  return { event: value, kind: "semantic" };
}

function isMeaningfulEvent(event: StreamEvent): boolean {
  return event.type === "text_delta"
    || event.type === "thinking_delta"
    || event.type === "tool_call_start"
    || event.type === "tool_call_delta"
    || event.type === "tool_call_end"
    || event.type === "server_tool_result"
    || event.type === "native_block_start"
    || event.type === "native_block_delta"
    || event.type === "native_block_stop"
    || event.type === "context_item"
    || event.type === "compaction_start"
    || event.type === "compaction_delta"
    || event.type === "compaction_stop";
}

function preContentEventSize(event: StreamEvent): number {
  return event.type === "message_start" ? event.id.length + 32 : 128;
}

function bufferPreContentEvent(buffer: StreamEvent[], event: StreamEvent, currentBytes: number): number | null {
  if (buffer.length >= MAX_PRE_CONTENT_EVENTS) return null;
  const nextBytes = currentBytes + preContentEventSize(event);
  if (nextBytes > MAX_PRE_CONTENT_BYTES) return null;
  if (event.type === "message_start" && buffer.some((item) => item.type === "message_start")) return null;
  buffer.push(event);
  return nextBytes;
}

/** Yields events while tracking meaningful output and terminal state. */
export async function* trackStream(events: AsyncIterable<StreamEvent>, lifecycle: StreamLifecycleController): AsyncGenerator<StreamEvent> {
  for await (const event of events) {
    if (isMeaningfulEvent(event)) lifecycle.markMeaningfulOutput();
    if (isTerminalEvent(event)) lifecycle.markTerminalSeen();
    yield event;
  }
}

// ---------------------------------------------------------------- error mapping

/** Structural check for application `ProviderCallError`-shaped failures. */
export function isProviderCallError(value: unknown): value is ProviderCallError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; sanitizedMessage?: unknown; retryable?: unknown };
  return typeof candidate.kind === "string" && typeof candidate.sanitizedMessage === "string" && typeof candidate.retryable === "boolean";
}

/**
 * Maps an arbitrary thrown value to a typed `ProviderCallError`. Uses the
 * caller's `mapError` when given, then typed errors carrying their own
 * `toProviderCallError` (e.g. `StreamDecodeError`, adapter errors), then the
 * structural check, and only falls back to a sanitized `internal_error` —
 * never a fabricated success.
 */
export function toProviderCallError(value: unknown, mapError?: (error: unknown) => ProviderCallError): ProviderCallError {
  if (mapError !== undefined) return mapError(value);
  if (typeof value === "object" && value !== null && "toProviderCallError" in value) {
    const convertible = value as { toProviderCallError?: unknown };
    if (typeof convertible.toProviderCallError === "function") {
      return (convertible as { toProviderCallError(): ProviderCallError }).toProviderCallError();
    }
  }
  if (isProviderCallError(value)) return value;
  return {
    statusCode: null,
    kind: "internal_error",
    retryable: false,
    routeScope: null,
    source: deriveErrorSource("internal_error", null),
    sanitizedMessage: sanitizeMessage(value),
    retryAt: null,
  };
}

function clientAbortedCallError(): ProviderCallError {
  return {
    statusCode: null,
    kind: "client_aborted",
    retryable: false,
    routeScope: null,
    source: deriveErrorSource("client_aborted", null),
    sanitizedMessage: "Request aborted by client",
    retryAt: null,
  };
}

function truncatedCallError(): ProviderCallError {
  return {
    statusCode: null,
    kind: "stream_truncated",
    retryable: true,
    routeScope: "provider",
    source: deriveErrorSource("stream_truncated", "provider"),
    sanitizedMessage: "Stream ended before a terminal event",
    retryAt: null,
  };
}

function internalCallError(message: string): ProviderCallError {
  return {
    statusCode: null,
    kind: "internal_error",
    retryable: false,
    routeScope: null,
    source: deriveErrorSource("internal_error", null),
    sanitizedMessage: sanitizeMessage(message),
    retryAt: null,
  };
}

/** Waits for a bounded backoff or Retry-After timestamp and aborts promptly. */
export async function waitBeforeRetry(error: ProviderCallError, retryIndex: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw clientAbortedCallError();
  const retryAtMs = error.retryAt === null ? null : Date.parse(error.retryAt);
  const retryAfterMs = retryAtMs !== null && Number.isFinite(retryAtMs) ? Math.max(0, Math.min(5_000, retryAtMs - Date.now())) : null;
  const baseMs = Math.min(2_000, 50 * 2 ** Math.min(retryIndex, 6));
  const delayMs = retryAfterMs ?? baseMs + Math.floor(Math.random() * Math.min(50, Math.max(1, Math.floor(baseMs / 4))));
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (errorValue?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (errorValue) reject(errorValue);
      else resolve();
    };
    const onAbort = (): void => finish(clientAbortedCallError());
    const timer = setTimeout(() => finish(), delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

// ---------------------------------------------------------------- recovery

export interface RecoverCallOptions {
  /** One provider execution; re-invoked with the next index on retry. */
  readonly attempt: (index: number) => Promise<ProviderOutput>;
  /** Total attempts allowed across the call (initial + retries). */
  readonly maxAttempts: number;
  readonly signal: AbortSignal;
  /** Released exactly once at the final outcome; stream mode defers to stream end. */
  readonly cleanup: CleanupStack;
  /** Lifecycle consulted for the meaningful-output retry gate; created when omitted. */
  readonly lifecycle?: StreamLifecycleController;
  /** Maps thrown values to typed errors; defaults to `toProviderCallError`. */
  readonly mapError?: (error: unknown) => ProviderCallError;
  /** Retry decision on top of the meaningful-output gate; defaults to `retryable` and not aborted. */
  readonly shouldRetry?: (error: ProviderCallError) => boolean;
  /** Failure hook (route health, switch metadata) called per failed attempt, before deciding. */
  readonly onFailure?: (error: ProviderCallError, index: number) => void | Promise<void>;
  /** Optional cancellation-aware delay before a retry. */
  readonly waitBeforeRetry?: (error: ProviderCallError, retryIndex: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Runs up to `maxAttempts` provider attempts. Pre-stream failures retry only
 * when `shouldRetry` permits and attempts remain; the returned Stream output
 * is wrapped so a mid-stream failure also retries only while no meaningful
 * output and no terminal event have been emitted. On the final failure a
 * typed error is thrown — never an empty successful completion — and the
 * cleanup stack is released exactly once.
 */
export async function recoverCall(options: RecoverCallOptions): Promise<ProviderOutput> {
  const { attempt, maxAttempts, signal, cleanup } = options;
  const lifecycle = options.lifecycle ?? createStreamLifecycle();
  const shouldRetry = options.shouldRetry ?? ((error: ProviderCallError): boolean => error.retryable && !signal.aborted);
  const waitForRetry = options.waitBeforeRetry ?? waitBeforeRetry;
  let lastError: ProviderCallError | null = null;

  for (let index = 0; index < maxAttempts; index++) {
    if (signal.aborted) {
      await cleanup.run();
      throw clientAbortedCallError();
    }
    let output: ProviderOutput;
    try {
      output = await attempt(index);
    } catch (error) {
      const failure = toProviderCallError(error, options.mapError);
      lastError = failure;
      await options.onFailure?.(failure, index);
      if (!shouldRetry(failure) || index + 1 >= maxAttempts) {
        await cleanup.run();
        throw failure;
      }
      await waitForRetry(failure, index + 1, signal);
      continue;
    }
    if (output.mode === "non_stream") {
      await cleanup.run();
      return output;
    }
    // Stream mode: cleanup and further retries belong to the stream lifetime.
    return {
      ...output,
      events: recoverableEvents(output.events, {
        attempt,
        startIndex: index + 1,
        maxAttempts,
        signal,
        cleanup,
        lifecycle,
        mapError: options.mapError,
        shouldRetry,
        onFailure: options.onFailure,
        waitBeforeRetry: waitForRetry,
      }),
    };
  }

  await cleanup.run();
  throw lastError ?? internalCallError("All retry attempts exhausted without a captured error — this indicates an internal state bug in the recovery loop");
}

interface RecoverableEventsOptions {
  readonly attempt: (index: number) => Promise<ProviderOutput>;
  readonly startIndex: number;
  readonly maxAttempts: number;
  readonly signal: AbortSignal;
  readonly cleanup: CleanupStack;
  readonly lifecycle: StreamLifecycleController;
  readonly mapError?: (error: unknown) => ProviderCallError;
  readonly shouldRetry: (error: ProviderCallError) => boolean;
  readonly onFailure?: (error: ProviderCallError, index: number) => void | Promise<void>;
  readonly waitBeforeRetry: (error: ProviderCallError, retryIndex: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Wraps a live event stream: tracks lifecycle state, fails typed on
 * truncation, and re-attempts only when the failure occurred before any
 * meaningful output or terminal event and the retry policy permits. Cleanup
 * is released exactly once, on any exit (terminal, failure, consumer
 * cancellation, abort). The caller's `attempt` must be re-entrant (it
 * re-selects credential/network resources for each retry).
 */
async function* recoverableEvents(initial: AsyncIterable<StreamEvent>, options: RecoverableEventsOptions): AsyncGenerator<StreamEvent> {
  const { attempt, maxAttempts, signal, cleanup, lifecycle } = options;
  let events: AsyncIterable<StreamEvent> | null = initial;
  let index = options.startIndex;
  try {
    while (true) {
      if (signal.aborted) throw clientAbortedCallError();
      if (events !== null) {
        const subscription = events;
        events = null;
        const openingBuffer: StreamEvent[] = [];
        let openingBytes = 0;
        let semanticSeen = lifecycle.meaningfulOutput;
        let terminalSeen = lifecycle.terminalSeen;
        let failure: ProviderCallError | null = null;
        try {
          for await (const rawEvent of subscription as AsyncIterable<unknown>) {
            if (signal.aborted) {
              failure = clientAbortedCallError();
              break;
            }
            const classified = classifyStreamEvent(rawEvent);
            if (classified === null) {
              failure = new StreamDecodeError("provider_protocol_error", "Malformed provider stream event").toProviderCallError();
              break;
            }
            const { event, kind } = classified;
            if (terminalSeen || (semanticSeen && kind === "pre_content")) {
              failure = new StreamDecodeError("provider_protocol_error", "Provider stream lifecycle event was out of order").toProviderCallError();
              break;
            }
            if (kind === "pre_content") {
              const nextBytes = bufferPreContentEvent(openingBuffer, event, openingBytes);
              if (nextBytes === null) {
                failure = new StreamDecodeError("provider_protocol_error", "Provider stream opening metadata exceeds the bounded buffer").toProviderCallError();
                break;
              }
              openingBytes = nextBytes;
              continue;
            }
            if (kind === "semantic") {
              if (!semanticSeen) {
                semanticSeen = true;
                lifecycle.markMeaningfulOutput();
                for (const buffered of openingBuffer) yield buffered;
                openingBuffer.length = 0;
              }
              yield event;
              continue;
            }
            for (const buffered of openingBuffer) yield buffered;
            openingBuffer.length = 0;
            terminalSeen = true;
            lifecycle.markTerminalSeen();
            yield event;
            return;
          }
          if (failure === null) failure = truncatedCallError();
        } catch (error) {
          failure = toProviderCallError(error, options.mapError);
        }
        if (failure === null) throw internalCallError("Stream recovery ended without a captured failure");
        if (signal.aborted) throw clientAbortedCallError();
        await options.onFailure?.(failure, index);
        if (signal.aborted) throw clientAbortedCallError();
        const retryable = index < maxAttempts && !lifecycle.meaningfulOutput && !lifecycle.terminalSeen && options.shouldRetry(failure);
        if (!retryable) throw failure;
        index++;
        await options.waitBeforeRetry(failure, index, signal);
        if (signal.aborted) throw clientAbortedCallError();
      }
      let output: ProviderOutput;
      try {
        output = await attempt(index);
      } catch (error) {
        const failure = toProviderCallError(error, options.mapError);
        if (signal.aborted) throw clientAbortedCallError();
        await options.onFailure?.(failure, index);
        if (signal.aborted) throw clientAbortedCallError();
        const retryable = index < maxAttempts && !lifecycle.meaningfulOutput && !lifecycle.terminalSeen && options.shouldRetry(failure);
        if (!retryable) throw failure;
        index++;
        await options.waitBeforeRetry(failure, index, signal);
        continue;
      }
      if (output.mode !== "stream") {
        throw new StreamDecodeError("provider_protocol_error", "Provider returned a non-stream response for a stream request").toProviderCallError();
      }
      events = output.events;
    }
  } finally {
    await cleanup.run();
  }
}
