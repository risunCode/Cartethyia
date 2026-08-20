package middleware

import "net/http"

// Decision is the outcome of an admission check. The Reason field is
// surfaced to clients when the decision denies a request; it should be
// short and stable for logging.
type Decision struct {
	Allow  bool
	Reason string
}

// Limiter is the contract for rate-based admission. Implementations decide
// how to count requests, but must be safe for concurrent use.
type Limiter interface {
	// Allow returns the admission decision for the given key. A nil error
	// alongside Allow=false means the caller is rate limited; a non-nil
	// error means the limiter itself failed and the request should be
	// rejected with the appropriate status.
	Allow(key string) (Decision, error)
}

// ConcurrencyCap is the contract for in-flight admission. Acquire reserves
// a slot; Release returns it. A non-nil error from Acquire means no slot
// could be reserved and the caller should be rejected.
type ConcurrencyCap interface {
	Acquire(key string) (release func(), err error)
}

// RateLimit wraps a Limiter and rejects excess requests with 429.
func RateLimit(limiter Limiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if limiter == nil {
				next.ServeHTTP(w, r)
				return
			}
			decision, err := limiter.Allow(ClientKey(r))
			if err != nil {
				writeError(w, http.StatusServiceUnavailable, "rate limiter unavailable")
				return
			}
			if !decision.Allow {
				writeError(w, http.StatusTooManyRequests, decision.Reason)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Concurrency wraps a ConcurrencyCap and rejects requests when no slot is
// available. The reserved slot is released after the handler returns.
func Concurrency(cap ConcurrencyCap) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if cap == nil {
				next.ServeHTTP(w, r)
				return
			}
			release, err := cap.Acquire(ClientKey(r))
			if err != nil {
				writeError(w, http.StatusServiceUnavailable, "concurrency limit reached")
				return
			}
			defer release()
			next.ServeHTTP(w, r)
		})
	}
}
