// Tracing primitives for the daemon observability package.
//
// TraceContext follows the W3C Trace Context recommendation (traceparent /
// tracestate). Span, Tracer, and TracerProvider are vendor-neutral interfaces
// so handlers, proxy code, and runtime wiring can attach a real OpenTelemetry
// SDK later without changing call sites. Defaults are no-op so a Registry can
// be constructed before the SDK choice is made.
//
// Propagation helpers (ExtractHTTP / InjectHTTP) and correlation helpers
// (RequestFields / TraceFields) give HTTP handlers a single call to set up
// trace-aware logging for an incoming request.
package observability

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// TraceContext is the W3C Trace Context propagated between services.
type TraceContext struct {
	TraceID    string
	SpanID     string
	TraceFlags byte
	TraceState string
}

// W3C trace flag bits.
const (
	TraceFlagSampled byte = 0x01
)

const (
	traceIDHexLen = 32
	spanIDHexLen  = 16
	traceIDZero   = "00000000000000000000000000000000"
	spanIDZero    = "0000000000000000"
)

var traceparentPattern = regexp.MustCompile(`^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$`)

// NewTraceContext creates a fresh trace context with the sampled flag set.
func NewTraceContext() TraceContext {
	return TraceContext{
		TraceID:    randomHex(traceIDHexLen),
		SpanID:     randomHex(spanIDHexLen),
		TraceFlags: TraceFlagSampled,
	}
}

// NewChildTraceContext creates a child context sharing the parent's trace id
// and flags. The returned SpanID is a fresh random identifier.
func NewChildTraceContext(parent TraceContext) TraceContext {
	return TraceContext{
		TraceID:    parent.TraceID,
		SpanID:     randomHex(spanIDHexLen),
		TraceFlags: parent.TraceFlags,
		TraceState: parent.TraceState,
	}
}

// IsZero reports whether the context is uninitialised.
func (c TraceContext) IsZero() bool {
	return c.TraceID == "" && c.SpanID == ""
}

// IsSampled reports whether the sampled flag is set.
func (c TraceContext) IsSampled() bool {
	return c.TraceFlags&TraceFlagSampled != 0
}

// TraceParent formats the context as a W3C traceparent header value. The
// returned string uses version 00, which is the only version currently
// defined by the recommendation.
func (c TraceContext) TraceParent() string {
	return fmt.Sprintf("00-%s-%s-%02x", c.TraceID, c.SpanID, c.TraceFlags)
}

// ParseTraceParent parses a W3C traceparent header value.
// Returns ok=false if the value is malformed, uses an unsupported version,
// or references an all-zero identifier.
func ParseTraceParent(header string) (TraceContext, bool) {
	match := traceparentPattern.FindStringSubmatch(strings.TrimSpace(header))
	if match == nil {
		return TraceContext{}, false
	}
	if match[1] != "00" {
		return TraceContext{}, false
	}
	traceID, spanID, flagsHex := match[2], match[3], match[4]
	if traceID == traceIDZero || spanID == spanIDZero {
		return TraceContext{}, false
	}
	flags, err := parseHexByte(flagsHex)
	if err != nil {
		return TraceContext{}, false
	}
	return TraceContext{TraceID: traceID, SpanID: spanID, TraceFlags: flags}, true
}

func parseHexByte(s string) (byte, error) {
	if len(s) != 2 {
		return 0, errors.New("not 2 hex chars")
	}
	var b byte
	for i := 0; i < 2; i++ {
		c := s[i]
		switch {
		case '0' <= c && c <= '9':
			b = b<<4 | byte(c-'0')
		case 'a' <= c && c <= 'f':
			b = b<<4 | byte(c-'a'+10)
		default:
			return 0, errors.New("not hex")
		}
	}
	return b, nil
}

func randomHex(n int) string {
	if n <= 0 || n%2 != 0 {
		return ""
	}
	b := make([]byte, n/2)
	if _, err := rand.Read(b); err == nil {
		return hex.EncodeToString(b)
	}
	// Fallback for the rare rand failure. Quality is not cryptographic but is
	// sufficient to keep trace ids unique within a process lifetime.
	seed := uint64(time.Now().UnixNano())
	for i := range b {
		// Linear congruential generator step (numerical recipes constants).
		seed = seed*6364136223846793005 + 1442695040888963407
		b[i] = byte(seed >> 56)
	}
	return hex.EncodeToString(b)
}

// StatusCode is the outcome of a span.
type StatusCode uint32

const (
	StatusUnset StatusCode = iota
	StatusOK
	StatusError
)

// Attribute is a key-value annotation attached to a span.
type Attribute struct {
	Key   string
	Value any
}

// AttrString formats a string value.
func AttrString(key, value string) Attribute { return Attribute{key, value} }

// AttrInt formats an int value.
func AttrInt(key string, value int) Attribute { return Attribute{key, value} }

// AttrInt64 formats an int64 value.
func AttrInt64(key string, value int64) Attribute { return Attribute{key, value} }

// AttrFloat64 formats a float64 value.
func AttrFloat64(key string, value float64) Attribute { return Attribute{key, value} }

// AttrBool formats a bool value.
func AttrBool(key string, value bool) Attribute { return Attribute{key, value} }

// AttrDuration formats a duration.
func AttrDuration(key string, value time.Duration) Attribute {
	return Attribute{key, value}
}

// AttrTime formats a time.
func AttrTime(key string, value time.Time) Attribute { return Attribute{key, value} }

// AttrAny formats an arbitrary value.
func AttrAny(key string, value any) Attribute { return Attribute{key, value} }

// Span is a single unit of work within a trace.
type Span interface {
	End()
	SetAttribute(key string, value any)
	SetAttributes(attrs ...Attribute)
	AddEvent(name string, attrs ...Attribute)
	RecordError(err error, attrs ...Attribute)
	SetStatus(code StatusCode, description string)
	// TraceContext returns the trace context this span participates in.
	TraceContext() TraceContext
}

// Tracer creates spans.
type Tracer interface {
	// Start opens a new span as a child of any span already attached to ctx.
	// The returned context carries the new span so downstream code can attach
	// attributes or propagate the trace via context.Value.
	Start(ctx context.Context, name string) (context.Context, Span)
}

// TracerProvider returns named tracers. The name typically identifies the
// instrumentation library (e.g. "server", "proxy").
type TracerProvider interface {
	Tracer(name string) Tracer
}

// --- context plumbing ---

type spanContextKey struct{}

// WithSpan attaches span to ctx so downstream calls can retrieve it via
// SpanFromContext.
func WithSpan(ctx context.Context, span Span) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, spanContextKey{}, span)
}

// SpanFromContext returns the span attached to ctx, if any.
func SpanFromContext(ctx context.Context) (Span, bool) {
	if ctx == nil {
		return nil, false
	}
	s, ok := ctx.Value(spanContextKey{}).(Span)
	return s, ok
}

type traceContextKey struct{}

// WithTraceContext attaches tc to ctx for downstream propagation. The value
// is independent of any Span attached via WithSpan; both are useful in
// different code paths.
func WithTraceContext(ctx context.Context, tc TraceContext) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, traceContextKey{}, tc)
}

// TraceContextFromContext returns the trace context attached to ctx, if any.
func TraceContextFromContext(ctx context.Context) (TraceContext, bool) {
	if ctx == nil {
		return TraceContext{}, false
	}
	tc, ok := ctx.Value(traceContextKey{}).(TraceContext)
	return tc, ok
}

// --- HTTP propagation ---

// Standard W3C / correlation header names.
const (
	HeaderTraceParent = "traceparent"
	HeaderTraceState  = "tracestate"
	HeaderRequestID   = "X-Request-Id"
)

// ExtractHTTP reads a W3C trace context from the request headers. If none is
// present, a new context is generated so the request can still be traced end
// to end. The X-Request-Id header is intentionally not folded into the trace
// context; it is exposed via RequestFields instead.
func ExtractHTTP(r *http.Request) TraceContext {
	if r == nil {
		return NewTraceContext()
	}
	if tp := r.Header.Get(HeaderTraceParent); tp != "" {
		if tc, ok := ParseTraceParent(tp); ok {
			tc.TraceState = r.Header.Get(HeaderTraceState)
			return tc
		}
	}
	return NewTraceContext()
}

// InjectHTTP writes a W3C trace context onto the response headers. The
// traceparent is omitted for a zero context so callers do not emit a
// malformed header.
func InjectHTTP(h http.Header, tc TraceContext) {
	if h == nil || tc.IsZero() {
		return
	}
	h.Set(HeaderTraceParent, tc.TraceParent())
	if tc.TraceState != "" {
		h.Set(HeaderTraceState, tc.TraceState)
	}
}

// --- correlation helpers ---

// RequestFields returns a safe set of correlation fields for an HTTP
// request. Header values that could carry credentials are not emitted; the
// user_agent is included verbatim. The X-Request-Id header, when present,
// is mapped to the request_id field so downstream services can correlate
// logs even when no W3C trace context is propagated.
func RequestFields(r *http.Request) []Field {
	if r == nil {
		return nil
	}
	fields := []Field{
		String("http.method", r.Method),
		String("http.path", r.URL.Path),
	}
	if r.URL.Host != "" {
		fields = append(fields, String("http.host", r.URL.Host))
	}
	if r.RemoteAddr != "" {
		fields = append(fields, String("http.remote_addr", r.RemoteAddr))
	}
	if ua := r.Header.Get("User-Agent"); ua != "" {
		fields = append(fields, String("http.user_agent", ua))
	}
	if rid := r.Header.Get(HeaderRequestID); rid != "" {
		fields = append(fields, String("request_id", rid))
	}
	return fields
}

// TraceFields returns the trace correlation fields for a trace context.
// Returns nil for a zero context so callers can append the result without
// special-casing.
func TraceFields(tc TraceContext) []Field {
	if tc.IsZero() {
		return nil
	}
	return []Field{
		String("trace_id", tc.TraceID),
		String("span_id", tc.SpanID),
		Bool("trace.sampled", tc.IsSampled()),
	}
}

// --- no-op implementations ---

type noopSpan struct{ ctx TraceContext }

// NoopSpan returns a Span that drops every operation. The supplied trace
// context is reported back by TraceContext() so log records still carry the
// correlation ids a real span would have produced.
func NoopSpan(tc TraceContext) Span { return noopSpan{ctx: tc} }

func (noopSpan) End()                            {}
func (noopSpan) SetAttribute(string, any)        {}
func (noopSpan) SetAttributes(...Attribute)      {}
func (noopSpan) AddEvent(string, ...Attribute)   {}
func (noopSpan) RecordError(error, ...Attribute) {}
func (noopSpan) SetStatus(StatusCode, string)    {}
func (s noopSpan) TraceContext() TraceContext    { return s.ctx }

type noopTracer struct{}

// NoopTracer returns a Tracer that produces no-op spans carrying any trace
// context already attached to the supplied context.Context.
func NoopTracer() Tracer { return noopTracer{} }

func (noopTracer) Start(ctx context.Context, _ string) (context.Context, Span) {
	tc, _ := TraceContextFromContext(ctx)
	return ctx, noopSpan{ctx: tc}
}

// NoopTracerProvider returns a TracerProvider that yields a no-op Tracer.
// It is the default tracer held by a freshly constructed Registry.
type NoopTracerProvider struct{}

// Tracer returns a no-op tracer for the given name.
func (NoopTracerProvider) Tracer(string) Tracer { return noopTracer{} }
