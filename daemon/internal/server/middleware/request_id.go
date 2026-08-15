package middleware

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"

	apicontracts "github.com/cartethyia/daemon/internal/server/api/contracts"
)

// HeaderRequestID is the canonical header used to propagate a request
// identifier through downstream handlers and the response.
const (
	HeaderRequestID = "X-Request-Id"
	HeaderTraceID   = "X-Trace-Id"
)

// RequestID assigns a request identifier to each incoming request. When the
// incoming request already carries a header value it is preserved, otherwise
// RequestID assigns bounded request and trace identifiers to each incoming
// request. Invalid inbound values are discarded rather than reflected.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(HeaderRequestID)
		if apicontracts.ValidateRequestID("request_id", id) != nil {
			id = newRequestID()
		}
		traceID := r.Header.Get(HeaderTraceID)
		if apicontracts.ValidateRequestID("trace_id", traceID) != nil {
			traceID = newRequestID()
		}

		r.Header.Set(HeaderRequestID, id)
		r.Header.Set(HeaderTraceID, traceID)
		w.Header().Set(HeaderRequestID, id)
		w.Header().Set(HeaderTraceID, traceID)
		ctx := withTraceID(withRequestID(r.Context(), id), traceID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequestIDFrom extracts the request identifier from a request context. It
// returns an empty string when the middleware did not run for this request.
func RequestIDFrom(ctx requestIDContext) string {
	if ctx == nil {
		return ""
	}
	if v, ok := requestIDValue(ctx); ok {
		return v
	}
	return ""
}

func newRequestID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// Fall back to a static, non-secret placeholder; the value still
		// provides correlation within a single process for diagnostics.
		return "00000000000000000000000000000000"
	}
	return hex.EncodeToString(buf[:])
}
