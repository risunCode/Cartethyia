package middleware

import "context"

// contextKey is a private type used to attach middleware state to a request
// context. Using a named type avoids collisions with keys defined in other
// packages.
type contextKey int

const (
	contextKeyRequestID contextKey = iota
	contextKeyTraceID
	contextKeyIdentity
)

const (
	requestOriginHeader = "X-Request-Origin"
	clientFamilyHeader  = "X-Client-Family"
)

// requestIDContext is the minimal interface accepted by RequestIDFrom. The
// concrete type is always a context.Context, but accepting the interface
// here lets call sites pass any context that satisfies it.
type requestIDContext interface {
	Value(key any) any
}

func withRequestID(parent context.Context, id string) context.Context {
	return context.WithValue(parent, contextKeyRequestID, id)
}

func requestIDValue(ctx requestIDContext) (string, bool) {
	v := ctx.Value(contextKeyRequestID)
	s, ok := v.(string)
	return s, ok && s != ""
}

func withTraceID(parent context.Context, id string) context.Context {
	return context.WithValue(parent, contextKeyTraceID, id)
}

func traceIDValue(ctx requestIDContext) (string, bool) {
	v := ctx.Value(contextKeyTraceID)
	s, ok := v.(string)
	return s, ok && s != ""
}

// TraceIDFrom extracts the trace identifier attached by RequestID.
func TraceIDFrom(ctx requestIDContext) string {
	if ctx == nil {
		return ""
	}
	if v, ok := traceIDValue(ctx); ok {
		return v
	}
	return ""
}
