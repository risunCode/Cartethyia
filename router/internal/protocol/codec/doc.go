// Package codec ports the open-sse translation foundation for the
// Cartethyia Go daemon. It exposes pure, allocation-conscious entry points
// that convert between the three wire surfaces the runtime speaks today:
//
//   - OpenAI Chat Completions        (contracts.ProtocolOpenAIChat)
//   - OpenAI Responses               (contracts.ProtocolOpenAIResponse)
//   - Anthropic Messages             (contracts.ProtocolAnthropic)
//
// The package never starts listeners, never imports the provider or HTTP
// handler packages, and never embeds Devin proto types. It is safe to call
// from any goroutine: every function is deterministic given its inputs
// and the caller-supplied mode (stream / non-stream).
//
// The public surface is intentionally narrow:
//
//   - RequestDecoder  decodes a raw []byte body for a given inbound protocol
//     into a canonical NormalizedRequest, or returns a
//     TransformError describing the first validation failure.
//   - RequestEncoder  encodes a canonical NormalizedRequest into a wire
//     payload for a given outbound protocol.
//   - ResponseDecoder decodes a raw provider response body into a canonical
//     NormalizedResponse (events + usage + stop reason).
//   - ResponseEncoder encodes a canonical NormalizedResponse into a wire
//     body for the requested outbound protocol.
//
// Streaming is supported by an explicit stream flag on the encoder/decoder
// paths. Encoders emit `stream: true` and `stream_options.include_usage`
// for the OpenAI surfaces when the canonical request requests streaming;
// Anthropic uses `stream: true` directly. Unknown fields are never dropped
// silently: passthrough behavior is documented per-encoder and field
// dispositions are recorded in the encoder result.
package codec
