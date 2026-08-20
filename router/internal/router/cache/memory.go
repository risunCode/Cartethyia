package cache

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// MemoryConfig configures the L0 in-memory cache backend. A zero value is
// valid and produces an unbounded cache (no eviction, no expiry) which is
// only useful for tests.
type MemoryConfig struct {
	// MaxEntries bounds the number of stored entries. Zero means unbounded.
	// When the bound is reached and a Set would exceed it, the least
	// recently used entry is evicted.
	MaxEntries int
	// MaxInFlight bounds the number of distinct keys whose loader is
	// running concurrently under GetOrLoad. Zero means unbounded; non-zero
	// values prevent loader stampedes during catalog rebuilds.
	MaxInFlight int
	// MaxBytes bounds total payload bytes held by the cache. Zero means
	// unbounded and is retained for isolated unit tests.
	MaxBytes int64
	// Clock returns the current wall-clock time. Defaults to time.Now.
	Clock func() time.Time
}

func (c *MemoryConfig) applyDefaults() {
	if c.Clock == nil {
		c.Clock = time.Now
	}
}

// Memory is the L0 in-memory backend described by R-CACHE-01. It satisfies
// Cache, GenerationInvalidator, and MissCoalescer.
//
// Memory is concurrency-safe; a single instance may be shared across
// goroutines. After Close, every Get/Set/Delete returns ErrClosed and Health
// reports HealthOffline. Close is idempotent.
type Memory struct {
	mu       sync.Mutex
	entries  map[string]*list.Element
	lru      *list.List
	inflight map[string]*flight
	closed   bool

	maxEntries   int
	maxInFlight  int
	maxBytes     int64
	currentBytes int64
	clock        func() time.Time

	hits      atomic.Uint64
	misses    atomic.Uint64
	lastErrMu sync.Mutex
	lastErr   error
}
type flight struct {
	done     chan struct{}
	doneOnce sync.Once
	cancel   context.CancelFunc
	entry    Entry
	err      error
}

// DefaultMaxInFlight is the suggested cap for MaxInFlight when callers want
// bounded miss coalescing. It is intentionally generous so that a catalog
// rebuild under load does not immediately reject concurrent resolutions.
const DefaultMaxInFlight = 256

// ErrBusy is returned by GetOrLoad when the configured MaxInFlight is reached
// and a new distinct key would start an additional loader. Callers can retry
// after a small backoff or fall back to a direct Get-then-Load path.
var ErrBusy = errors.New("cache: miss coalescer at capacity")

// NewMemory constructs the L0 backend with the supplied config.
func NewMemory(cfg MemoryConfig) *Memory {
	cfg.applyDefaults()
	return &Memory{
		entries:     make(map[string]*list.Element),
		lru:         list.New(),
		inflight:    make(map[string]*flight),
		maxEntries:  cfg.MaxEntries,
		maxInFlight: cfg.MaxInFlight,
		maxBytes:    cfg.MaxBytes,
		clock:       cfg.Clock,
	}
}

// entryElement is the value stored in the LRU list. The wire key is duplicated
// on the element so eviction (which only knows the *list.Element) can delete
// from the map without consulting the Key.
type entryElement struct {
	wire  string
	value storedEntry
}

// Get implements Cache.Get. Generation mismatch is a typed error so callers
// can distinguish it from a plain miss via errors.Is(err, ErrGenerationMismatch).
func (m *Memory) Get(ctx context.Context, key Key) (Entry, error) {
	if ctx == nil {
		return Entry{}, ErrInvalidContext
	}
	if err := ctx.Err(); err != nil {
		return Entry{}, err
	}
	if err := key.validate(); err != nil {
		return Entry{}, err
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Entry{}, ErrClosed
	}
	el, ok := m.entries[key.Wire()]
	if !ok {
		m.recordMiss()
		m.mu.Unlock()
		return Entry{}, &MissError{Key: key}
	}
	elem := el.Value.(*entryElement)
	now := m.clock()
	if !now.Before(elem.value.expiresAt) {
		// Expired: evict on access and report a typed miss.
		m.removeElement(el)
		m.recordMiss()
		m.mu.Unlock()
		return Entry{}, &MissError{Key: key, Reason: "expired"}
	}
	if !elem.value.generation.Equal(key.Generation) {
		// Generation mismatch: drop the entry; the catalog has moved on.
		m.removeElement(el)
		m.recordMiss()
		m.mu.Unlock()
		return Entry{}, &GenerationMismatchError{
			Key:       key,
			Stored:    elem.value.generation,
			Requested: key.Generation,
		}
	}
	// LRU touch.
	m.lru.MoveToFront(el)
	remaining := elem.value.expiresAt.Sub(now)
	value := append([]byte(nil), elem.value.payload...)
	stored := elem.value
	owner := stored.owner
	m.mu.Unlock()

	m.recordHit()
	return Entry{
		Key:        owner,
		Value:      value,
		StoredAt:   stored.storedAt,
		ExpiresAt:  stored.expiresAt,
		Generation: stored.generation,
		Remaining:  remaining,
		Hit:        true,
		HitReason:  HitReasonMemory,
	}, nil
}

// Set implements Cache.Set.
func (m *Memory) Set(ctx context.Context, key Key, value []byte, ttl time.Duration) error {
	if ctx == nil {
		return ErrInvalidContext
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := key.validate(); err != nil {
		return err
	}
	if ttl <= 0 {
		return ErrInvalidTTL
	}
	// Defensive copy so callers can mutate their slice after Set returns.
	payload := append([]byte(nil), value...)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrClosed
	}
	now := m.clock()
	stored := storedEntry{
		key:        key.Wire(),
		owner:      key,
		payload:    payload,
		storedAt:   now,
		expiresAt:  now.Add(ttl),
		generation: key.Generation,
	}
	if el, ok := m.entries[stored.key]; ok {
		old := el.Value.(*entryElement).value
		m.currentBytes -= int64(len(old.payload))
		el.Value.(*entryElement).value = stored
		m.currentBytes += int64(len(stored.payload))
		m.lru.MoveToFront(el)
		m.evictIfNeeded()
	} else {
		el := m.lru.PushFront(&entryElement{wire: stored.key, value: stored})
		m.entries[stored.key] = el
		m.currentBytes += int64(len(stored.payload))
		m.evictIfNeeded()
	}
	m.mu.Unlock()
	return nil
}

// Delete implements Cache.Delete.
func (m *Memory) Delete(ctx context.Context, key Key) error {
	if ctx == nil {
		return ErrInvalidContext
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := key.validate(); err != nil {
		return err
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrClosed
	}
	if el, ok := m.entries[key.Wire()]; ok {
		m.removeElement(el)
	}
	m.mu.Unlock()
	return nil
}

// InvalidateGeneration drops entries whose stored generation matches gen.
func (m *Memory) InvalidateGeneration(ctx context.Context, gen Generation) (int, error) {
	if ctx == nil {
		return 0, ErrInvalidContext
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return 0, ErrClosed
	}
	removed := 0
	for el := m.lru.Front(); el != nil; {
		next := el.Next()
		elem := el.Value.(*entryElement)
		if elem.value.generation.Equal(gen) {
			m.removeElement(el)
			removed++
		}
		el = next
	}
	m.mu.Unlock()
	return removed, nil
}

// InvalidateAccount drops entries whose stored scope matches the supplied
// provider/account. An empty accountID invalidates the whole provider.
func (m *Memory) InvalidateAccount(ctx context.Context, provider, accountID string) (int, error) {
	if ctx == nil {
		return 0, ErrInvalidContext
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return 0, ErrClosed
	}
	removed := 0
	for el := m.lru.Front(); el != nil; {
		next := el.Next()
		elem := el.Value.(*entryElement)
		scope := elem.value.owner.Scope
		if scope.Provider != provider {
			el = next
			continue
		}
		if accountID != "" && scope.AccountID != accountID {
			el = next
			continue
		}
		m.removeElement(el)
		removed++
		el = next
	}
	m.mu.Unlock()
	return removed, nil
}

// InvalidateAll drops every entry.
func (m *Memory) InvalidateAll(ctx context.Context) (int, error) {
	if ctx == nil {
		return 0, ErrInvalidContext
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return 0, ErrClosed
	}
	removed := len(m.entries)
	m.currentBytes = 0
	m.entries = make(map[string]*list.Element)
	m.lru.Init()
	m.mu.Unlock()
	return removed, nil
}

// Health implements Cache.Health.
func (m *Memory) Health(_ context.Context) Health {
	m.mu.Lock()
	state := HealthOnline
	if m.closed {
		state = HealthOffline
	}
	entries := len(m.entries)
	capacity := m.maxEntries
	m.mu.Unlock()

	m.lastErrMu.Lock()
	lastErr := m.lastErr
	m.lastErrMu.Unlock()

	return Health{
		State:       state,
		LastChecked: m.clock(),
		LastError:   lastErr,
		Entries:     entries,
		Capacity:    capacity,
		Hits:        m.hits.Load(),
		Misses:      m.misses.Load(),
	}
}

// Close implements Cache.Close. Idempotent.
func (m *Memory) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	// Cancel leader loaders so they unblock promptly, then wake waiters
	// with ErrClosed.
	for _, f := range m.inflight {
		if f.cancel != nil {
			f.cancel()
		}
		f.err = ErrClosed
		closeFlight(f)
	}
	m.inflight = make(map[string]*flight)
	m.entries = make(map[string]*list.Element)
	m.lru.Init()
	m.mu.Unlock()
	return nil
}

// GetOrLoad implements MissCoalescer. It first checks the cache; on miss it
// either runs loader (as the leader) or waits for an existing leader's
// result. GetOrLoad enforces MaxInFlight: when the cap is reached and the
// caller would otherwise become a new leader, it returns ErrBusy so the
// caller can decide whether to retry or fall back.
func (m *Memory) GetOrLoad(ctx context.Context, key Key, loader Loader) (Entry, error) {
	if ctx == nil {
		return Entry{}, ErrInvalidContext
	}
	if err := ctx.Err(); err != nil {
		return Entry{}, err
	}
	if err := key.validate(); err != nil {
		return Entry{}, err
	}
	if loader == nil {
		return Entry{}, fmt.Errorf("cache: loader must not be nil")
	}

	// Fast path: existing entry.
	entry, err := m.Get(ctx, key)
	if err == nil {
		return entry, nil
	}
	if !isMiss(err) && !errors.Is(err, ErrGenerationMismatch) {
		return Entry{}, err
	}

	wire := key.Wire()

	// Try to register as leader. The leader context is a child of the
	// caller's context so Close can also cancel the loader mid-flight.
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Entry{}, ErrClosed
	}
	if existing, ok := m.inflight[wire]; ok {
		// Join existing flight.
		m.mu.Unlock()
		return waitForFlight(ctx, existing)
	}
	if m.maxInFlight > 0 && len(m.inflight) >= m.maxInFlight {
		m.mu.Unlock()
		m.recordLastErr(ErrBusy)
		return Entry{}, ErrBusy
	}
	leaderCtx, cancelLeader := context.WithCancel(ctx)
	f := &flight{
		done:   make(chan struct{}),
		cancel: cancelLeader,
	}
	m.inflight[wire] = f
	m.mu.Unlock()

	// Leader: run loader.
	loaded, loadErr := loader(leaderCtx, key)

	// Re-acquire cache state to publish the result and free the slot.
	m.mu.Lock()
	delete(m.inflight, wire)
	cancelLeader()
	if m.closed {
		// Close already published ErrClosed and closed this flight while
		// holding m.mu. Do not mutate the flight after publication: waiters
		// may already be reading its result.
		m.mu.Unlock()
		return Entry{}, ErrClosed
	}
	if loadErr == nil {
		// Best-effort cache the loader result with a positive TTL. We use
		// a default TTL of one minute when the loader did not specify one.
		// Note: the loader may have used GetOrLoad indirectly; we cache the
		// returned value at its declared expiry window.
		ttl := defaultLoaderTTL
		if !loaded.ExpiresAt.IsZero() && loaded.ExpiresAt.After(m.clock()) {
			ttl = loaded.ExpiresAt.Sub(m.clock())
		}
		if ttl > 0 {
			m.setLocked(loaded.Key, loaded.Value, ttl)
		}
	}
	loaded.Value = append([]byte(nil), loaded.Value...)
	f.entry = loaded
	f.err = loadErr
	closeFlight(f)
	m.mu.Unlock()
	result := loaded
	result.Value = append([]byte(nil), loaded.Value...)
	return result, loadErr
}

const defaultLoaderTTL = 60 * time.Second

func (m *Memory) setLocked(key Key, value []byte, ttl time.Duration) {
	payload := append([]byte(nil), value...)
	now := m.clock()
	stored := storedEntry{
		key:        key.Wire(),
		owner:      key,
		payload:    payload,
		storedAt:   now,
		expiresAt:  now.Add(ttl),
		generation: key.Generation,
	}
	if el, ok := m.entries[stored.key]; ok {
		old := el.Value.(*entryElement).value
		m.currentBytes -= int64(len(old.payload))
		el.Value.(*entryElement).value = stored
		m.currentBytes += int64(len(stored.payload))
		m.lru.MoveToFront(el)
		m.evictIfNeeded()
		return
	}
	el := m.lru.PushFront(&entryElement{wire: stored.key, value: stored})
	m.entries[stored.key] = el
	m.currentBytes += int64(len(stored.payload))
	m.evictIfNeeded()
}

// waitForFlight blocks until the leader publishes its result, ctx is
// cancelled, or the backend is closed mid-flight.
func waitForFlight(ctx context.Context, f *flight) (Entry, error) {
	if err := ctx.Err(); err != nil {
		return Entry{}, err
	}
	select {
	case <-f.done:
		entry := f.entry
		entry.Value = append([]byte(nil), entry.Value...)
		return entry, f.err
	case <-ctx.Done():
		return Entry{}, ctx.Err()
	}
}
func closeFlight(f *flight) {
	f.doneOnce.Do(func() { close(f.done) })
}

// removeElement deletes el from both the LRU list and the entries map. The
// caller must hold m.mu.
func (m *Memory) removeElement(el *list.Element) {
	if el == nil {
		return
	}
	elem := el.Value.(*entryElement)
	delete(m.entries, elem.wire)
	m.currentBytes -= int64(len(elem.value.payload))
	if m.currentBytes < 0 {
		m.currentBytes = 0
	}
	m.lru.Remove(el)
}

// evictIfNeeded enforces MaxEntries. The caller must hold m.mu.
func (m *Memory) evictIfNeeded() {
	if m.maxEntries <= 0 && m.maxBytes <= 0 {
		return
	}
	for (m.maxEntries > 0 && len(m.entries) > m.maxEntries) || (m.maxBytes > 0 && m.currentBytes > m.maxBytes) {
		back := m.lru.Back()
		if back == nil {
			return
		}
		m.removeElement(back)
	}
}

func (m *Memory) recordHit()  { m.hits.Add(1) }
func (m *Memory) recordMiss() { m.misses.Add(1) }

func (m *Memory) recordLastErr(err error) {
	if err == nil {
		return
	}
	m.lastErrMu.Lock()
	m.lastErr = err
	m.lastErrMu.Unlock()
}

// isMiss reports whether err represents a non-typed miss (no entry, expired,
// or generation-mismatch treated as miss by the coalescer).
func isMiss(err error) bool {
	return errors.Is(err, ErrMiss)
}
