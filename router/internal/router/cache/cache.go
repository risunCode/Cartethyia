package cache

import (
	"context"
	"time"
)

// Loader resolves a Key on miss. It is invoked at most once per coalesced
// flight; concurrent callers waiting on the same key observe the same result.
//
// The Loader MUST honour ctx cancellation. Returning a non-nil error causes
// GetOrLoad to surface that error to every waiter; subsequent calls retry.
type Loader func(ctx context.Context, key Key) (Entry, error)

// Cache is the Cartethyia resolution-cache contract. The L0 memory backend
// and the optional L1 Redis backend both implement this interface so callers
// never depend on a Redis client directly (R-CACHE-01).
//
// All methods accept a context for cancellation and deadlines. Implementations
// MUST honour ctx and MUST return ErrClosed after Close.
type Cache interface {
	// Get returns the cached entry for key. Implementations:
	//   - return ErrMiss (concrete *MissError) when no entry exists.
	//   - return a *GenerationMismatchError when the stored entry's
	//     Generation does not match the requested key's Generation
	//     (R-CACHE-04). Callers MUST treat this as a miss.
	//   - return ErrClosed when the backend has been closed.
	//   - return ctx.Err() when ctx is cancelled before the lookup
	//     completes.
	Get(ctx context.Context, key Key) (Entry, error)

	// Set records value under key with the given TTL. A non-positive TTL
	// returns ErrInvalidTTL. Implementations MUST enforce the capacity bound
	// (LRU eviction for the memory backend) and MUST refuse to accept
	// values after Close.
	Set(ctx context.Context, key Key, value []byte, ttl time.Duration) error

	// Delete removes the entry for key. Deleting a missing key is a no-op.
	Delete(ctx context.Context, key Key) error

	// Health reports the current backend state. Implementations MUST be
	// concurrency-safe and MUST not block on I/O for the in-memory backend.
	Health(ctx context.Context) Health

	// Close releases backend resources. After Close, Get/Set/Delete return
	// ErrClosed and Health reports HealthOffline. Close is idempotent.
	Close() error
}

// GenerationInvalidator is an optional extension of Cache that supports
// generation-aware bulk invalidation (R-CACHE-04, R-CACHE-05). The L0 memory
// backend implements it; future backends should match.
type GenerationInvalidator interface {
	// InvalidateGeneration drops every entry whose recorded Generation
	// matches gen. Returns the number of entries removed.
	InvalidateGeneration(ctx context.Context, gen Generation) (int, error)

	// InvalidateAccount drops every entry whose recorded Scope matches the
	// supplied provider/account pair. An empty accountID invalidates the
	// entire provider. Returns the number of entries removed.
	InvalidateAccount(ctx context.Context, provider, accountID string) (int, error)

	// InvalidateAll drops every entry. Returns the number removed.
	InvalidateAll(ctx context.Context) (int, error)
}

// MissCoalescer is an optional extension of Cache that bounds concurrent miss
// coalescing (R-CACHE-05). When multiple goroutines call GetOrLoad for the
// same key concurrently, the loader runs once and all waiters receive the
// same result. The number of distinct in-flight keys is bounded by the
// MaxInFlight configured on the backend.
type MissCoalescer interface {
	// GetOrLoad returns the cached entry or runs loader exactly once for
	// concurrent callers waiting on the same key. The loader runs in the
	// caller's goroutine (the first caller); waiters block on a channel
	// until the leader reports the result. Returns ErrClosed when the
	// backend has been closed.
	GetOrLoad(ctx context.Context, key Key, loader Loader) (Entry, error)
}
