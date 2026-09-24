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
   * must handle it in their stream generator / completion serializer.
   */
  abstract finish(): TWire[];
}
