package router

import "sync"

// Cache stores a token-saver result for a given input. The interface is
// intentionally narrow: the proxy runtime can provide the concrete backend
// without making the local filter depend on storage.
//
// Implementations MUST be safe for concurrent use. Get may return a cached
// Outcome whose Request is safe to re-use as a read-only template; callers that
// intend to mutate it should Clone first. Set is best-effort: a non-nil error
// is treated as ReasonCacheError by the orchestrator but the request still
// proceeds.
type Cache interface {
	// Get returns the cached outcome for key, or (zero Outcome, false, nil)
	// on a miss. An error is reported as a backend failure; callers should
	// log it and treat the call as a miss.
	Get(key string) (Outcome, bool, error)

	// Set stores out under key. The returned error, if non-nil, is surfaced
	// via Summary.Reason=ReasonCacheError but does not fail the request.
	Set(key string, out Outcome) error
}

// NoopCache is a Cache that always misses and silently discards writes. It is
// the safe default when the operator has not configured a backing store; the
// token-saving stage still runs end-to-end so behavior is identical to the
// uncached path.
type NoopCache struct{}

// Get always reports a miss.
func (NoopCache) Get(string) (Outcome, bool, error) { return Outcome{}, false, nil }

// Set always succeeds with no side effect.
func (NoopCache) Set(string, Outcome) error { return nil }

// MemoryCache is a minimal in-process Cache backed by a map. It exists so the
// package can be exercised without a storage dependency. It is NOT eviction
// aware; the runtime should wrap it in an LRU/bounded store if the process is
// long-lived.
type MemoryCache struct {
	mu      sync.RWMutex
	entries map[string]Outcome
}

// NewMemoryCache returns an empty MemoryCache ready for use.
func NewMemoryCache() *MemoryCache {
	return &MemoryCache{entries: map[string]Outcome{}}
}

// Get returns the cached outcome when present.
func (c *MemoryCache) Get(key string) (Outcome, bool, error) {
	if c == nil {
		return Outcome{}, false, nil
	}
	c.mu.RLock()
	v, ok := c.entries[key]
	c.mu.RUnlock()
	if ok {
		v.Request = v.Request.Clone()
	}
	return v, ok, nil
}

// Set records out under key, replacing any prior value.
func (c *MemoryCache) Set(key string, out Outcome) error {
	if c == nil {
		return nil
	}
	out.Request = out.Request.Clone()
	c.mu.Lock()
	if c.entries == nil {
		c.entries = make(map[string]Outcome)
	}
	c.entries[key] = out
	c.mu.Unlock()
	return nil
}

// Len reports the current entry count; intended for tests and metrics.
func (c *MemoryCache) Len() int {
	if c == nil {
		return 0
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.entries)
}
