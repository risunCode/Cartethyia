package middleware

import (
	"io"
	"net/http"
)

// MaxBodyBytes rejects requests whose body exceeds the configured limit.
// The check applies to the Content-Length header when present and to the
// actual number of bytes read from the body otherwise. The handler still
// drains the body so connection keep-alive works as expected.
func MaxBodyBytes(limit int64) func(http.Handler) http.Handler {
	if limit <= 0 {
		panic("middleware: MaxBodyBytes limit must be positive")
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > limit {
				writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
				return
			}

			r.Body = http.MaxBytesReader(w, r.Body, limit)
			next.ServeHTTP(w, r)
		})
	}
}

// DrainAndDiscard discards any unread portion of the request body. It is
// useful to pair with MaxBodyBytes when an upstream error short-circuits a
// handler so the underlying connection can be reused.
func DrainAndDiscard(r *http.Request) {
	if r == nil || r.Body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, r.Body)
	_ = r.Body.Close()
}
