/**
 * Event emission and response buffering for one streamed attempt.
 *
 * Owns the surface encoder (SSE framing), the client transcript copy used by
 * telemetry, and the per-event bookkeeping — the terminal event, usage, and
 * the first-byte / first-content timestamps — that stream completion reads
 * afterwards. Extracted from `dispatchStreamingAttempt` as a seam, not a
 * behavior change: method bodies are the original closure bodies, and the
 * observable ordering (buffer bookkeeping → terminal/usage capture →
 * client-visible tracking → encode + enqueue) is preserved exactly.
 */
import type { CanonicalEvent, SourceSurface, UsageRecord } from "../../../protocol/canonical-model";
import { createDispatchStreamEncoder, type DispatchStreamEncoder } from "../stream-bridge";

/** The terminal event shape every stream settles (or fails to settle) on. */
export type StreamTerminalEvent = Extract<CanonicalEvent, { type: "terminal" }>;

/**
 * SSE comment frame: valid framing on every streamed surface, ignored by
 * EventSource clients. Never part of content/telemetry.
 */
export const KEEPALIVE_COMMENT_BYTES = new TextEncoder().encode(": keepalive\n\n");

/** Diagnostic transcript budget. Client-facing frames remain uncapped here. */
const CLIENT_RESPONSE_CAP = 512 * 1024;
const EVENT_TRANSCRIPT_CAP = 512 * 1024;
const EVENT_TRANSCRIPT_HEAD_CAP = EVENT_TRANSCRIPT_CAP / 2;
const EVENT_TRANSCRIPT_TAIL_CAP = EVENT_TRANSCRIPT_CAP - EVENT_TRANSCRIPT_HEAD_CAP;

interface TruncatedEventTranscript {
  readonly _truncated: true;
  readonly _omitted_events: number;
  readonly events: readonly (CanonicalEvent & { timestamp: number })[];
  readonly usage?: UsageRecord;
  readonly terminal?: {
    readonly type: "terminal";
    readonly sequence_number: number;
    readonly state: StreamTerminalEvent["state"];
    readonly stop_reason?: StreamTerminalEvent["stop_reason"];
    readonly usage?: UsageRecord;
  };
}

/** Error-frame input in the shape the dispatch stream encoder accepts. */
export type StreamErrorFrameInput = Parameters<DispatchStreamEncoder["encodeError"]>[0];

/**
 * Per-event state and framing for one stream. Client framing and protocol
 * bookkeeping process every event; only the telemetry transcript is bounded.
 */
export class StreamEventPipeline {
  /** Terminal event once the upstream produced one (or a synthetic truncation terminal was emitted). */
  terminal: StreamTerminalEvent | undefined;
  usage: UsageRecord | undefined;
  /** Wall-clock ms of the first byte actually enqueued to the client. */
  firstByteAt: number | undefined;
  firstContentDeltaAtMs: number | undefined;
  lastEventAtMs: number | undefined;
  private readonly eventTranscriptHead: Array<CanonicalEvent & { timestamp: number }> = [];
  private readonly eventTranscriptTail: Array<CanonicalEvent & { timestamp: number }> = [];
  private eventTranscriptHeadBytes = 0;
  private eventTranscriptTailBytes = 0;
  private totalEventCount = 0;

  private readonly recoverableResponsesPrelude: boolean;
  private clientVisibleEvent = false;
  private clientResponseTextValue = "";
  // One decoder per stream: `new TextDecoder()` per chunk would allocate
  // on every upstream event for the telemetry transcript copy.
  private readonly clientResponseDecoder = new TextDecoder();
  private readonly streamEncoder: DispatchStreamEncoder;

  constructor(
    surface: SourceSurface,
    encoderOptions: Record<string, unknown>,
    recoverableResponsesPrelude: boolean,
  ) {
    this.streamEncoder = createDispatchStreamEncoder(surface, encoderOptions);
    this.recoverableResponsesPrelude = recoverableResponsesPrelude;
  }

  /** Number of canonical events processed, including those omitted from diagnostics. */
  get eventCount(): number {
    return this.totalEventCount;
  }

  /** Whether any client-renderable event has been emitted (gates the Responses prelude retry). */
  get hasClientVisibleEvent(): boolean {
    return this.clientVisibleEvent;
  }

  /** The client-facing response transcript (decoded SSE/JSON) — distinct from the provider-side canonical events. */
  get clientResponseText(): string {
    return this.clientResponseTextValue;
  }

  /** Bounded canonical-event transcript for telemetry; the wire stream is unaffected. */
  get telemetryEventTranscript():
    | readonly (CanonicalEvent & { timestamp: number })[]
    | TruncatedEventTranscript {
    const events = [...this.eventTranscriptHead, ...this.eventTranscriptTail];
    const omittedEvents = this.totalEventCount - events.length;
    if (omittedEvents === 0) return events;
    const terminal = this.terminal;
    return {
      _truncated: true,
      _omitted_events: omittedEvents,
      events,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(terminal === undefined
        ? {}
        : {
            terminal: {
              type: "terminal" as const,
              sequence_number: terminal.sequence_number,
              state: terminal.state,
              ...(terminal.stop_reason === undefined ? {} : { stop_reason: terminal.stop_reason }),
              ...(terminal.usage === undefined ? {} : { usage: terminal.usage }),
            },
          }),
    };
  }

  private recordTelemetryEvent(event: CanonicalEvent & { timestamp: number }): void {
    this.totalEventCount += 1;
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (this.eventTranscriptHeadBytes + eventBytes <= EVENT_TRANSCRIPT_HEAD_CAP) {
      this.eventTranscriptHead.push(event);
      this.eventTranscriptHeadBytes += eventBytes;
      return;
    }
    if (eventBytes > EVENT_TRANSCRIPT_TAIL_CAP) return;
    while (this.eventTranscriptTailBytes + eventBytes > EVENT_TRANSCRIPT_TAIL_CAP) {
      const removed = this.eventTranscriptTail.shift();
      if (removed === undefined) break;
      this.eventTranscriptTailBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
    }
    this.eventTranscriptTail.push(event);
    this.eventTranscriptTailBytes += eventBytes;
  }

  private isClientVisibleEvent(event: CanonicalEvent): boolean {
    if (event.type === "tool_call_delta" || event.type === "tool_result") return true;
    if (event.type === "content_delta") {
      // Extension payloads carry no client-renderable content. Reasoning
      // deltas do: they drive the reasoning pane, and withholding them
      // until the first answer token left the client blank for the whole
      // reasoning phase (seconds to minutes). A reasoning delta commits
      // the candidate the same way answer text does.
      return event.content.kind !== "extension";
    }
    return event.type === "terminal" && event.state === "complete";
  }

  private appendClientResponse(bytes: Uint8Array): void {
    if (this.clientResponseTextValue.length >= CLIENT_RESPONSE_CAP) return;
    this.clientResponseTextValue += this.clientResponseDecoder.decode(bytes, { stream: true });
    if (this.clientResponseTextValue.length > CLIENT_RESPONSE_CAP)
      this.clientResponseTextValue = this.clientResponseTextValue.slice(0, CLIENT_RESPONSE_CAP);
  }

  private pushEncodedEvent(
    event: CanonicalEvent & { timestamp: number },
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    const toEnqueue = this.streamEncoder.push(event);
    if (toEnqueue.length > 0 && this.firstByteAt === undefined) this.firstByteAt = Date.now();
    for (const bytes of toEnqueue) {
      controller.enqueue(bytes);
      this.appendClientResponse(bytes);
    }
    return toEnqueue.length > 0;
  }

  /**
   * Records one canonical event and frames it onto the client stream.
   * Returns whether any wire bytes were enqueued (an event can be
   * intentionally invisible on the selected client surface).
   */
  enqueueEvent(
    event: CanonicalEvent,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    const timestampedEvent = { ...event, timestamp: Date.now() };
    this.recordTelemetryEvent(timestampedEvent);
    this.lastEventAtMs = timestampedEvent.timestamp;

    if (event.type === "content_delta" && this.firstContentDeltaAtMs === undefined) {
      this.firstContentDeltaAtMs = timestampedEvent.timestamp;
    }

    if (event.type === "terminal") {
      this.terminal = event;
      if (event.usage) this.usage = event.usage;
    } else if (event.type === "usage") {
      this.usage = event.usage;
    }
    // A Responses prelude that carries no client-renderable content
    // (response_start, usage, extension deltas) is tracked so a provider
    // that closes before producing anything can be retried once. It is
    // streamed as it arrives, not held: holding it until the first answer
    // token blanked the client for the whole reasoning phase, which is the
    // perceived "first response is slow and doesn't chunk" behavior.
    if (this.recoverableResponsesPrelude && this.isClientVisibleEvent(event)) {
      this.clientVisibleEvent = true;
    }
    return this.pushEncodedEvent(timestampedEvent, controller);
  }

  /** Flushes the surface encoder's closing frames (including the `[DONE]` sentinel). */
  finishEncoders(controller: ReadableStreamDefaultController<Uint8Array>): void {
    for (const bytes of this.streamEncoder.finish()) {
      controller.enqueue(bytes);
      this.appendClientResponse(bytes);
    }
  }

  /** Frames and enqueues the terminal SSE error event, recording it in the client transcript. */
  emitErrorFrame(
    input: StreamErrorFrameInput,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    for (const bytes of this.streamEncoder.encodeError(input)) {
      controller.enqueue(bytes);
      this.appendClientResponse(bytes);
    }
  }

  /**
   * Discards the buffered state of a Responses prelude that never reached
   * the client, so the single pre-content retry starts from a clean slate.
   * `clientVisibleEvent` is deliberately NOT reset: once anything
   * client-renderable was emitted the retry guard must stay closed.
   */
  resetUncommittedPrelude(): void {
    this.eventTranscriptHead.length = 0;
    this.eventTranscriptTail.length = 0;
    this.eventTranscriptHeadBytes = 0;
    this.eventTranscriptTailBytes = 0;
    this.totalEventCount = 0;
    this.terminal = undefined;
    this.usage = undefined;
    this.lastEventAtMs = undefined;
  }
}
