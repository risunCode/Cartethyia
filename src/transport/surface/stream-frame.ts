// Streaming-encoder surface contract.
//
// The pure SSE frame builders (`buildSseEventFrame`, `formatSseEvent`,
// `formatSseData`, `TEXT_ENCODER`) live in `src/protocol/sse-frame.ts` — both the
// data plane (surface encoders here) and the control plane
// (`console/observability/sse.ts`) consume them, and the frame format is a
// wire detail with no layer ownership. This file keeps only the encoder
// abstract class, which IS a surface-adapter contract and has no console
// consumer.

/**
 * Base class for stateful streaming surface encoders.
 *
 * TEvent is the input event type (typically `CanonicalEvent`).
 * TWire is the output wire object/event type (e.g. `JsonObject`, `ResponsesWireEvent`, `MessagesStreamEvent`).
 */
export abstract class SurfaceStreamEncoder<TEvent, TWire> {
  /**
   * Translates a single input event into zero or more wire objects.
   */
  abstract push(event: TEvent): TWire[];

  /**
   * Flushes any remaining terminal or usage wire objects at stream completion.
   * NOTE: Does NOT emit `[DONE]`. Subclasses that require `[DONE]` (such as chat/completion)
   * must handle it in their stream generator / completion serializer — `[DONE]` is
   * emitted by `dispatch/stream-bridge.ts`, not by any encoder.
   */
  abstract finish(): TWire[];
}
