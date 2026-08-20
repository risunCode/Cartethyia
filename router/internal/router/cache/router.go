package cache

import (
	"context"
	"errors"
	"sync"
	"time"
)

// RemoteBackend is the narrow Redis-compatible boundary. The runtime can
// inject a RedisBackend (or another adapter) without exposing a Redis client
// to request-path packages.
type RemoteBackend interface {
	Cache
	Probe(context.Context) error
}

// RouterPolicy makes the distinction between advisory local fallback and
// coordination-critical operation explicit. Advisory is the default for
// resolution lookups. FailClosed never presents local memory as an equivalent
// distributed backend. SingleNode is an explicit operator choice that permits
// local-only operation while the remote backend is unavailable.
type RouterPolicy string

const (
	RouterPolicyAdvisory   RouterPolicy = "advisory"
	RouterPolicyFailClosed RouterPolicy = "fail_closed"
	RouterPolicySingleNode RouterPolicy = "single_node"
)

type Router struct {
	primary  RemoteBackend
	fallback Cache
	policy   RouterPolicy

	mu          sync.RWMutex
	state       HealthState
	lastChecked time.Time
	lastError   error
	closed      bool
}

// NewRouter constructs an advisory router. A nil primary means Redis is not
// configured and the router remains offline while serving the fallback.
func NewRouter(primary RemoteBackend, fallback Cache) (*Router, error) {
	return NewRouterWithPolicy(primary, fallback, RouterPolicyAdvisory)
}

// NewRouterWithPolicy constructs a router with explicit coordination policy.
func NewRouterWithPolicy(primary RemoteBackend, fallback Cache, policy RouterPolicy) (*Router, error) {
	if fallback == nil {
		return nil, cacheError(ErrRouterConfig, "construct", errors.New("fallback backend is required"))
	}
	if policy == "" {
		policy = RouterPolicyAdvisory
	}
	if policy != RouterPolicyAdvisory && policy != RouterPolicyFailClosed && policy != RouterPolicySingleNode {
		return nil, cacheError(ErrRouterConfig, "construct", errors.New("unknown router policy"))
	}
	state := HealthOffline
	if primary != nil {
		state = HealthUnhealthy
	}
	return &Router{
		primary:     primary,
		fallback:    fallback,
		policy:      policy,
		state:       state,
		lastChecked: time.Now(),
	}, nil
}

func (r *Router) snapshot(ctx context.Context) (Cache, bool, Health, error) {
	if ctx == nil {
		return nil, false, Health{}, cacheError(ErrRouterConfig, "context", errors.New("nil context"))
	}
	if err := ctx.Err(); err != nil {
		return nil, false, Health{}, err
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.closed {
		return nil, false, Health{State: HealthOffline, LastChecked: r.lastChecked}, ErrClosed
	}
	h := Health{State: r.state, LastChecked: r.lastChecked, LastError: r.lastError}
	if r.primary != nil && r.state == HealthOnline {
		return r.primary, true, h, nil
	}
	return r.fallback, false, h, nil
}

func (r *Router) unavailable(policy RouterPolicy, state HealthState) error {
	if policy != RouterPolicyFailClosed {
		return nil
	}
	if state == HealthOnline {
		return nil
	}
	return cacheError(ErrCoordinationUnavailable, "route", errors.New("remote backend is not online"))
}

func (r *Router) Probe(ctx context.Context) error {
	if ctx == nil {
		return cacheError(ErrRouterConfig, "probe context", errors.New("nil context"))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.RLock()
	if r.closed {
		r.mu.RUnlock()
		return ErrClosed
	}
	primary := r.primary
	r.mu.RUnlock()
	if primary == nil {
		r.mu.Lock()
		if !r.closed {
			r.state = HealthOffline
			r.lastChecked = time.Now()
			r.lastError = nil
		}
		r.mu.Unlock()
		return nil
	}

	err := primary.Probe(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		wrapped := cacheError(ErrRemoteProbe, "probe", err)
		r.mu.Lock()
		if !r.closed {
			r.state = HealthUnhealthy
			r.lastChecked = time.Now()
			r.lastError = wrapped
		}
		r.mu.Unlock()
		return wrapped
	}
	r.mu.Lock()
	if !r.closed {
		r.state = HealthOnline
		r.lastChecked = time.Now()
		r.lastError = nil
	}
	r.mu.Unlock()
	return nil
}

func (r *Router) Get(ctx context.Context, key Key) (Entry, error) {
	backend, primary, health, err := r.snapshot(ctx)
	if err != nil {
		return Entry{}, err
	}
	if err := r.unavailable(r.policy, health.State); err != nil {
		return Entry{}, err
	}
	entry, err := backend.Get(ctx, key)
	if err == nil {
		return entry, nil
	}
	// Miss and generation mismatch are expected cache outcomes, not health
	// failures. Advisory fallback may still find a local value.
	if !primary {
		return Entry{}, wrapFallbackError(err)
	}
	if !errors.Is(err, ErrMiss) && !errors.Is(err, ErrGenerationMismatch) {
		if ctx.Err() != nil {
			return Entry{}, ctx.Err()
		}
		primaryErr := normalizeRemoteError("get", err)
		r.markFailure(primaryErr)
		if r.policy == RouterPolicyFailClosed {
			return Entry{}, cacheError(ErrCoordinationUnavailable, "get", primaryErr)
		}
		fallbackEntry, fallbackErr := r.fallback.Get(ctx, key)
		if fallbackErr == nil {
			return fallbackEntry, nil
		}
		return Entry{}, cacheError(ErrFallback, "get", errors.Join(primaryErr, wrapFallbackError(fallbackErr)))
	}
	fallbackEntry, fallbackErr := r.fallback.Get(ctx, key)
	if fallbackErr == nil {
		return fallbackEntry, nil
	}
	return Entry{}, wrapFallbackError(fallbackErr)
}

func (r *Router) Set(ctx context.Context, key Key, value []byte, ttl time.Duration) error {
	backend, primary, health, err := r.snapshot(ctx)
	if err != nil {
		return err
	}
	if err := r.unavailable(r.policy, health.State); err != nil {
		return err
	}
	err = backend.Set(ctx, key, value, ttl)
	if err == nil {
		return nil
	}
	if !primary {
		return wrapFallbackError(err)
	}
	if errors.Is(err, ErrInvalidKey) || errors.Is(err, ErrInvalidTTL) {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	primaryErr := normalizeRemoteError("set", err)
	r.markFailure(primaryErr)
	if r.policy == RouterPolicyFailClosed {
		return cacheError(ErrCoordinationUnavailable, "set", primaryErr)
	}
	if fallbackErr := r.fallback.Set(ctx, key, value, ttl); fallbackErr != nil {
		return cacheError(ErrFallback, "set", errors.Join(primaryErr, wrapFallbackError(fallbackErr)))
	}
	return nil
}

func (r *Router) Delete(ctx context.Context, key Key) error {
	backend, primary, health, err := r.snapshot(ctx)
	if err != nil {
		return err
	}
	if err := r.unavailable(r.policy, health.State); err != nil {
		return err
	}
	err = backend.Delete(ctx, key)
	if err == nil {
		return nil
	}
	if !primary {
		return wrapFallbackError(err)
	}
	if errors.Is(err, ErrInvalidKey) {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	primaryErr := normalizeRemoteError("delete", err)
	r.markFailure(primaryErr)
	if r.policy == RouterPolicyFailClosed {
		return cacheError(ErrCoordinationUnavailable, "delete", primaryErr)
	}
	if fallbackErr := r.fallback.Delete(ctx, key); fallbackErr != nil {
		return cacheError(ErrFallback, "delete", errors.Join(primaryErr, wrapFallbackError(fallbackErr)))
	}
	return nil
}

// InvalidateGeneration forwards invalidation to every available generation
// aware backend. Remote invalidation is advisory; the local fallback is always
// attempted so a catalog refresh cannot leave stale L0 plans behind.
func (r *Router) InvalidateGeneration(ctx context.Context, gen Generation) (int, error) {
	if ctx == nil {
		return 0, cacheError(ErrRouterConfig, "invalidate context", errors.New("nil context"))
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	r.mu.RLock()
	if r.closed {
		r.mu.RUnlock()
		return 0, ErrClosed
	}
	primary, fallback, online := r.primary, r.fallback, r.state == HealthOnline
	r.mu.RUnlock()
	removed := 0
	var firstErr error
	if online {
		if inv, ok := primary.(GenerationInvalidator); ok {
			n, err := inv.InvalidateGeneration(ctx, gen)
			removed += n
			if err != nil {
				firstErr = err
				r.markFailure(normalizeRemoteError("invalidate", err))
			}
		}
	}
	if inv, ok := fallback.(GenerationInvalidator); ok {
		n, err := inv.InvalidateGeneration(ctx, gen)
		removed += n
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return removed, firstErr
}

func (r *Router) InvalidateAccount(ctx context.Context, provider, accountID string) (int, error) {
	if ctx == nil {
		return 0, cacheError(ErrRouterConfig, "invalidate context", errors.New("nil context"))
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	r.mu.RLock()
	if r.closed {
		r.mu.RUnlock()
		return 0, ErrClosed
	}
	primary, fallback, online := r.primary, r.fallback, r.state == HealthOnline
	r.mu.RUnlock()
	removed := 0
	var firstErr error
	if online {
		if inv, ok := primary.(GenerationInvalidator); ok {
			n, err := inv.InvalidateAccount(ctx, provider, accountID)
			removed += n
			if err != nil {
				firstErr = err
				r.markFailure(normalizeRemoteError("invalidate", err))
			}
		}
	}
	if inv, ok := fallback.(GenerationInvalidator); ok {
		n, err := inv.InvalidateAccount(ctx, provider, accountID)
		removed += n
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return removed, firstErr
}

func (r *Router) InvalidateAll(ctx context.Context) (int, error) {
	if ctx == nil {
		return 0, cacheError(ErrRouterConfig, "invalidate context", errors.New("nil context"))
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	r.mu.RLock()
	if r.closed {
		r.mu.RUnlock()
		return 0, ErrClosed
	}
	primary, fallback, online := r.primary, r.fallback, r.state == HealthOnline
	r.mu.RUnlock()
	removed := 0
	var firstErr error
	if online {
		if inv, ok := primary.(GenerationInvalidator); ok {
			n, err := inv.InvalidateAll(ctx)
			removed += n
			if err != nil {
				firstErr = err
				r.markFailure(normalizeRemoteError("invalidate", err))
			}
		}
	}
	if inv, ok := fallback.(GenerationInvalidator); ok {
		n, err := inv.InvalidateAll(ctx)
		removed += n
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return removed, firstErr
}

func (r *Router) Health(_ context.Context) Health {
	r.mu.RLock()
	defer r.mu.RUnlock()
	state := r.state
	if r.closed {
		state = HealthOffline
	}
	return Health{State: state, LastChecked: r.lastChecked, LastError: r.lastError}
}

func (r *Router) Close() error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	primary, fallback := r.primary, r.fallback
	r.state = HealthOffline
	r.lastChecked = time.Now()
	r.mu.Unlock()

	var closeErr error
	if primary != nil {
		if err := primary.Close(); err != nil {
			closeErr = cacheError(ErrRemoteCommand, "close", err)
		}
	}
	if fallback != nil {
		if err := fallback.Close(); err != nil {
			fallbackErr := wrapFallbackError(err)
			if closeErr == nil {
				closeErr = fallbackErr
			} else {
				closeErr = cacheError(ErrFallback, "close", errors.Join(closeErr, fallbackErr))
			}
		}
	}
	return closeErr
}

func (r *Router) markFailure(err error) {
	if err == nil {
		return
	}
	r.mu.Lock()
	if !r.closed {
		r.state = HealthUnhealthy
		r.lastChecked = time.Now()
		r.lastError = err
	}
	r.mu.Unlock()
}

func normalizeRemoteError(op string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrInvalidKey) || errors.Is(err, ErrInvalidTTL) || errors.Is(err, ErrMiss) || errors.Is(err, ErrGenerationMismatch) {
		return err
	}
	if _, ok := err.(*BackendError); ok {
		return err
	}
	return cacheError(ErrRemoteCommand, op, err)
}

func wrapFallbackError(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := err.(*BackendError); ok {
		return err
	}
	return cacheError(ErrFallback, "operation", err)
}

var _ Cache = (*Router)(nil)
var _ GenerationInvalidator = (*Router)(nil)
