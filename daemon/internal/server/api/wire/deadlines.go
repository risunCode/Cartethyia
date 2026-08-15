package wire

import (
	"context"
	"errors"
	"net/http"
	"time"
)

type streamDeadlineContextKey struct{}

type streamDeadlinePolicy struct {
	writeTimeout  time.Duration
	totalDeadline time.Time
	now           func() time.Time
}

// WithStreamDeadlines attaches the downstream streaming deadline policy to
// each request. The hard total budget starts at ingress; successful frames may
// refresh the write deadline but can never extend it beyond that budget.
func WithStreamDeadlines(next http.Handler, writeTimeout, totalTimeout time.Duration) http.Handler {
	if next == nil {
		return nil
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if writeTimeout <= 0 || totalTimeout <= 0 {
			next.ServeHTTP(w, r)
			return
		}
		now := time.Now
		policy := &streamDeadlinePolicy{
			writeTimeout:  writeTimeout,
			totalDeadline: now().Add(totalTimeout),
			now:           now,
		}
		ctx := context.WithValue(r.Context(), streamDeadlineContextKey{}, policy)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RefreshStreamWriteDeadline refreshes the downstream socket write deadline
// for the next complete stream frame. Unsupported response writers are a
// portable no-op; all other failures are returned to the unified finalizer.
func RefreshStreamWriteDeadline(ctx context.Context, w http.ResponseWriter) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	policy, _ := ctx.Value(streamDeadlineContextKey{}).(*streamDeadlinePolicy)
	if policy == nil || policy.writeTimeout <= 0 || policy.totalDeadline.IsZero() {
		return nil
	}
	now := policy.now()
	if !now.Before(policy.totalDeadline) {
		return context.DeadlineExceeded
	}
	deadline := now.Add(policy.writeTimeout)
	if deadline.After(policy.totalDeadline) {
		deadline = policy.totalDeadline
	}
	err := http.NewResponseController(w).SetWriteDeadline(deadline)
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}
