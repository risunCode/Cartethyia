package transforms

import (
	"context"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// RequestDecoder turns a raw inbound body into a canonical request.
type RequestDecoder interface {
	// Protocol reports the wire surface this decoder implements.
	Protocol() contracts.Protocol
	// Decode parses the body. The stream flag is supplied by the caller
	// when the wire surface does not encode it directly (e.g. when
	// detected from headers or query parameters upstream).
	Decode(ctx context.Context, body []byte, stream bool) (*NormalizedRequest, *TransformError)
}

// RequestEncoder projects a canonical request onto a wire surface.
type RequestEncoder interface {
	Protocol() contracts.Protocol
	// Encode returns the wire payload plus a disposition report describing
	// how every known field was routed. Opaque source-native fields are not
	// merged by global key name; same-surface callers apply NativeSidecar at
	// exact JSON pointers, while cross-surface callers require explicit maps.
	Encode(ctx context.Context, req *NormalizedRequest) (*EncoderResult, *TransformError)
}

// ResponseDecoder turns a raw provider response into canonical events.
type ResponseDecoder interface {
	Protocol() contracts.Protocol
	// Decode parses a non-streaming provider body. Streaming responses are
	// decoded incrementally by the transport layer using DecodeEvent.
	Decode(ctx context.Context, body []byte, model string) (*NormalizedResponse, *TransformError)
	// DecodeEvent parses a single streaming event frame.
	DecodeEvent(ctx context.Context, frame []byte) (*NormalizedEvent, *TransformError)
}

// ResponseEncoder projects a canonical response onto a wire surface.
type ResponseEncoder interface {
	Protocol() contracts.Protocol
	// Encode renders a non-streaming wire body from the canonical response.
	// Streaming is handled by EncodeEvent.
	Encode(ctx context.Context, resp *NormalizedResponse) (map[string]any, *TransformError)
	// EncodeEvent renders a streaming event frame. Returning a nil map
	// signals that the event should be skipped (e.g. an unsupported
	// reasoning delta on a non-OpenAI surface).
	EncodeEvent(ctx context.Context, event *NormalizedEvent) (map[string]any, *TransformError)
}

// Combined pairs a request and response codec for a given surface.
type Combined struct {
	Request  RequestEncoder
	Response ResponseEncoder
}

// Registry aggregates the codecs the runtime wants to expose. It does not
// own any state beyond the registered implementations.
type Registry struct {
	requests         map[contracts.Protocol]RequestEncoder
	decoders         map[contracts.Protocol]RequestDecoder
	responseDecoders map[contracts.Protocol]ResponseDecoder
	responses        map[contracts.Protocol]ResponseEncoder
}

// NewRegistry constructs an empty registry.
func NewRegistry() *Registry {
	return &Registry{
		requests:         make(map[contracts.Protocol]RequestEncoder),
		decoders:         make(map[contracts.Protocol]RequestDecoder),
		responseDecoders: make(map[contracts.Protocol]ResponseDecoder),
		responses:        make(map[contracts.Protocol]ResponseEncoder),
	}
}

// NewDefaultRegistry returns the canonical request codec set used by ingress
// and target projection. Response codecs remain independently registered by
// the provider/stream layer.
func NewDefaultRegistry() *Registry {
	r := NewRegistry()
	for _, codec := range []RequestEncoder{NewOpenAIChatCodec(), NewOpenAIResponsesCodec(), NewAnthropicMessagesCodec(), NewGeminiCodec()} {
		r.RegisterRequest(codec)
	}
	for _, decoder := range []RequestDecoder{NewOpenAIChatRequestDecoder(), NewOpenAIResponsesRequestDecoder(), NewAnthropicMessagesRequestDecoder(), NewGeminiRequestDecoder()} {
		r.RegisterDecoder(decoder)
	}
	for _, decoder := range []ResponseDecoder{NewOpenAIChatResponseDecoder(), NewOpenAIResponsesResponseDecoder(), NewAnthropicMessagesResponseDecoder(), NewGeminiResponseDecoder()} {
		r.RegisterResponseDecoder(decoder)
	}
	for _, encoder := range []ResponseEncoder{NewOpenAIChatResponseEncoder(), NewOpenAIResponsesResponseEncoder(), NewAnthropicMessagesResponseEncoder(), NewGeminiResponseEncoder()} {
		r.RegisterResponse(encoder)
	}
	return r
}

// RegisterRequest installs a request encoder. Registering a second
// implementation for the same surface is a programmer error.
func (r *Registry) RegisterRequest(e RequestEncoder) {
	if e == nil {
		return
	}
	if _, exists := r.requests[e.Protocol()]; exists {
		return
	}
	r.requests[e.Protocol()] = e
}

// RegisterDecoder installs an inbound request decoder for a surface.
func (r *Registry) RegisterDecoder(d RequestDecoder) {
	if d == nil {
		return
	}
	if _, exists := r.decoders[d.Protocol()]; exists {
		return
	}
	r.decoders[d.Protocol()] = d
}

// RegisterResponseDecoder installs a provider response decoder for a surface.
func (r *Registry) RegisterResponseDecoder(d ResponseDecoder) {
	if d == nil {
		return
	}
	if _, exists := r.responseDecoders[d.Protocol()]; exists {
		return
	}
	r.responseDecoders[d.Protocol()] = d
}

// LookupResponseDecoder returns the registered provider response decoder.
func (r *Registry) LookupResponseDecoder(p contracts.Protocol) (ResponseDecoder, bool) {
	d, ok := r.responseDecoders[p]
	return d, ok
}

// LookupDecoder returns the registered inbound request decoder.
func (r *Registry) LookupDecoder(p contracts.Protocol) (RequestDecoder, bool) {
	d, ok := r.decoders[p]
	return d, ok
}

// RegisterResponse installs a response encoder.
func (r *Registry) RegisterResponse(e ResponseEncoder) {
	if e == nil {
		return
	}
	if _, exists := r.responses[e.Protocol()]; exists {
		return
	}
	r.responses[e.Protocol()] = e
}

// LookupRequest returns the registered request encoder for a surface.
func (r *Registry) LookupRequest(p contracts.Protocol) (RequestEncoder, bool) {
	v, ok := r.requests[p]
	return v, ok
}

// LookupResponse returns the registered response encoder for a surface.
func (r *Registry) LookupResponse(p contracts.Protocol) (ResponseEncoder, bool) {
	v, ok := r.responses[p]
	return v, ok
}
