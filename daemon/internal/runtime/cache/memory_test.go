package cache

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// helperClock returns a deterministic clock for tests that exercise TTL.
func helperClock(start time.Time) (func() time.Time, func(time.Duration)) {
	var mu sync.Mutex
	cur := start
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return cur
	}
	advance := func(d time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		cur = cur.Add(d)
	}
	return clock, advance
}

func mustKey(t *testing.T, model string, surface string, gen Generation) Key {
	t.Helper()
	k, err := NewKey(model, surface, nil, gen, Scope{Provider: "openai"}, NetworkPolicy{}, AffinityNone)
	if err != nil {
		t.Fatalf("NewKey: %v", err)
	}
	return k
}

func TestSetGetRoundTrip(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	key := mustKey(t, "gpt-4o", "openai-chat", Generation{Catalog: 1})
	if err := c.Set(context.Background(), key, []byte("hello"), 5*time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}

	got, err := c.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !bytes.Equal(got.Value, []byte("hello")) {
		t.Fatalf("Value = %q, want %q", got.Value, "hello")
	}
	if got.Generation != key.Generation {
		t.Fatalf("Generation = %s, want %s", got.Generation, key.Generation)
	}
	if got.Remaining <= 0 {
		t.Fatalf("Remaining = %v, want > 0", got.Remaining)
	}
}

func TestGetReturnsMissWhenAbsent(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	_, err := c.Get(context.Background(), mustKey(t, "gpt-4o", "openai-chat", Generation{Catalog: 1}))
	if err == nil {
		t.Fatal("expected error for absent key")
	}
	if !errors.Is(err, ErrMiss) {
		t.Fatalf("err = %v, want errors.Is(err, ErrMiss)", err)
	}
}

func TestSetDefensiveCopy(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	key := mustKey(t, "gpt-4o", "openai-chat", Generation{Catalog: 1})
	src := []byte("original")
	if err := c.Set(context.Background(), key, src, time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}
	// Mutating the caller's slice must not corrupt the stored entry.
	copy(src, "MUTATED!")

	got, err := c.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !bytes.Equal(got.Value, []byte("original")) {
		t.Fatalf("stored value mutated through caller slice: %q", got.Value)
	}
	// And the entry value must not share backing memory with what we hand back.
	got.Value[0] = 'X'
	got2, err := c.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("second Get: %v", err)
	}
	if got2.Value[0] == 'X' {
		t.Fatal("Get returned shared backing array; caller mutation leaked into store")
	}
}

func TestSetRejectsNonPositiveTTL(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	key := mustKey(t, "gpt-4o", "openai-chat", Generation{Catalog: 1})
	if err := c.Set(context.Background(), key, []byte("x"), 0); !errors.Is(err, ErrInvalidTTL) {
		t.Fatalf("Set ttl=0 err = %v, want ErrInvalidTTL", err)
	}
	if err := c.Set(context.Background(), key, []byte("x"), -time.Second); !errors.Is(err, ErrInvalidTTL) {
		t.Fatalf("Set ttl<0 err = %v, want ErrInvalidTTL", err)
	}
}

func TestSetRejectsInvalidKey(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	cases := []struct {
		name string
		key  Key
	}{
		{"empty model", Key{Version: CurrentVersion, Surface: "openai-chat", Generation: Generation{Catalog: 1}, Scope: Scope{Provider: "openai"}}},
		{"empty surface", Key{Version: CurrentVersion, Model: "gpt-4o", Generation: Generation{Catalog: 1}, Scope: Scope{Provider: "openai"}}},
		{"zero generation", Key{Version: CurrentVersion, Model: "gpt-4o", Surface: "openai-chat", Scope: Scope{Provider: "openai"}}},
		{"zero version", Key{Model: "gpt-4o", Surface: "openai-chat", Generation: Generation{Catalog: 1}, Scope: Scope{Provider: "openai"}}},
		{"missing provider", Key{Version: CurrentVersion, Model: "gpt-4o", Surface: "openai-chat", Generation: Generation{Catalog: 1}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := c.Set(context.Background(), tc.key, []byte("x"), time.Minute); !errors.Is(err, ErrInvalidKey) {
				t.Fatalf("Set err = %v, want ErrInvalidKey", err)
			}
			if _, err := c.Get(context.Background(), tc.key); !errors.Is(err, ErrInvalidKey) {
				t.Fatalf("Get err = %v, want ErrInvalidKey", err)
			}
		})
	}
}

func TestExpiryEvictsOnAccess(t *testing.T) {
	clk, advance := helperClock(time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC))
	c := NewMemory(MemoryConfig{Clock: clk})
	defer c.Close()

	key := mustKey(t, "gpt-4o", "openai-chat", Generation{Catalog: 1})
	if err := c.Set(context.Background(), key, []byte("v"), 5*time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}

	advance(4 * time.Minute)
	if _, err := c.Get(context.Background(), key); err != nil {
		t.Fatalf("Get before expiry: %v", err)
	}

	advance(2 * time.Minute) // total 6 minutes > 5
	_, err := c.Get(context.Background(), key)
	if err == nil {
		t.Fatal("expected miss after TTL")
	}
	if !errors.Is(err, ErrMiss) {
		t.Fatalf("err = %v, want ErrMiss", err)
	}
}

func TestGenerationMismatchIsTypedMiss(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	base := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	key := mustKey(t, "gpt-4o", "openai-chat", base)
	if err := c.Set(context.Background(), key, []byte("v"), time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}

	// Same wire key fingerprint (model+surface unchanged) but a new generation.
	bumpedKey := mustKey(t, "gpt-4o", "openai-chat", Generation{Catalog: 2, Credentials: 1, Health: 1, Network: 1})
	_, err := c.Get(context.Background(), bumpedKey)
	if err == nil {
		t.Fatal("expected generation mismatch")
	}
	if !errors.Is(err, ErrGenerationMismatch) {
		t.Fatalf("err = %v, want errors.Is(err, ErrGenerationMismatch)", err)
	}
	var gm *GenerationMismatchError
	if !errors.As(err, &gm) {
		t.Fatalf("err is not a *GenerationMismatchError: %T", err)
	}
	if gm.Stored != base {
		t.Fatalf("stored = %s, want %s", gm.Stored, base)
	}
	if gm.Requested != bumpedKey.Generation {
		t.Fatalf("requested = %s, want %s", gm.Requested, bumpedKey.Generation)
	}
}

func TestGenerationMismatchEvicts(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	key := mustKey(t, "gpt-4o", "openai-chat", Generation{Catalog: 1})
	if err := c.Set(context.Background(), key, []byte("v"), time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}

	bumpedKey := mustKey(t, "gpt-4o", "openai-chat", Generation{Catalog: 2})
	if _, err := c.Get(context.Background(), bumpedKey); !errors.Is(err, ErrGenerationMismatch) {
		t.Fatalf("first bumped Get err = %v, want mismatch", err)
	}
	// The mismatch must have evicted the old entry.
	h := c.Health(context.Background())
	if h.Entries != 0 {
		t.Fatalf("Entries = %d, want 0 after mismatch eviction", h.Entries)
	}
}

func TestKeyFingerprintIsDeterministicAndOrderInsensitive(t *testing.T) {
	a, err := NewKey(
		"gpt-4o", "openai-chat",
		[]CapabilityRequirement{"tools", "streaming"},
		Generation{Catalog: 1, Credentials: 2, Health: 3, Network: 4},
		Scope{Provider: "openai", AccountID: "acct-1"},
		NetworkPolicy{Profile: "default", Egress: "tor"},
		AffinityStrong,
	)
	if err != nil {
		t.Fatalf("NewKey a: %v", err)
	}
	b, err := NewKey(
		"gpt-4o", "openai-chat",
		[]CapabilityRequirement{"streaming", "tools"}, // reversed
		Generation{Catalog: 1, Credentials: 2, Health: 3, Network: 4},
		Scope{Provider: "openai", AccountID: "acct-1"},
		NetworkPolicy{Profile: "default", Egress: "tor"},
		AffinityStrong,
	)
	if err != nil {
		t.Fatalf("NewKey b: %v", err)
	}
	if a.Wire() != b.Wire() {
		t.Fatalf("fingerprint not order-insensitive: %q vs %q", a.Wire(), b.Wire())
	}

	c2, err := NewKey(
		"gpt-4o", "openai-chat",
		[]CapabilityRequirement{"tools"},
		Generation{Catalog: 1, Credentials: 2, Health: 3, Network: 4},
		Scope{Provider: "openai", AccountID: "acct-1"},
		NetworkPolicy{Profile: "default", Egress: "tor"},
		AffinityStrong,
	)
	if err != nil {
		t.Fatalf("NewKey c: %v", err)
	}
	if a.Wire() == c2.Wire() {
		t.Fatal("different capability sets produced the same fingerprint")
	}
}

func TestDeleteRemovesEntry(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	key := mustKey(t, "gpt-4o", "openai-chat", Generation{Catalog: 1})
	if err := c.Set(context.Background(), key, []byte("v"), time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := c.Delete(context.Background(), key); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := c.Get(context.Background(), key); !errors.Is(err, ErrMiss) {
		t.Fatalf("Get after Delete err = %v, want ErrMiss", err)
	}
	// Deleting an absent key must be a no-op.
	if err := c.Delete(context.Background(), key); err != nil {
		t.Fatalf("Delete absent: %v", err)
	}
}

func TestInvalidateGeneration(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	// Wire fingerprints exclude generation, so each (model, surface, ...)
	// tuple stores at most one entry; the generation on that entry is the
	// latest write. InvalidateGeneration must remove every entry whose
	// recorded generation matches the supplied one and leave entries from
	// other generations untouched.
	g1 := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	g2 := Generation{Catalog: 2, Credentials: 1, Health: 1, Network: 1}
	k1a := mustKey(t, "gpt-4o", "openai-chat", g1)
	k1b := mustKey(t, "claude", "anthropic-messages", g1) // different shape, stored under g1
	k2 := mustKey(t, "claude", "anthropic-messages", g2)  // same shape as k1b, recorded under g2

	if err := c.Set(context.Background(), k1a, []byte("v"), time.Minute); err != nil {
		t.Fatalf("Set k1a: %v", err)
	}
	if err := c.Set(context.Background(), k1b, []byte("v"), time.Minute); err != nil {
		t.Fatalf("Set k1b: %v", err)
	}
	// Re-write k1b's shape with g2; this must overwrite the g1 entry.
	if err := c.Set(context.Background(), k2, []byte("v2"), time.Minute); err != nil {
		t.Fatalf("Set k2: %v", err)
	}

	removed, err := c.InvalidateGeneration(context.Background(), g1)
	if err != nil {
		t.Fatalf("InvalidateGeneration: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1 (k1a)", removed)
	}
	// Explicit invalidation removes the entry, so a subsequent read is a
	// typed miss rather than a generation mismatch from a retained value.
	if _, err := c.Get(context.Background(), k1a); !errors.Is(err, ErrMiss) {
		t.Fatalf("k1a after g1 invalidation: %v, want ErrMiss", err)
	}
	// k2 was recorded under g2 and must survive.
	if _, err := c.Get(context.Background(), k2); err != nil {
		t.Fatalf("k2 should survive g1 invalidation: %v", err)
	}

	// Now invalidate g2 and confirm k2 is gone and the cache is empty.
	removed, err = c.InvalidateGeneration(context.Background(), g2)
	if err != nil {
		t.Fatalf("InvalidateGeneration g2: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed g2 = %d, want 1", removed)
	}
	if h := c.Health(context.Background()); h.Entries != 0 {
		t.Fatalf("Entries after both invalidations = %d, want 0", h.Entries)
	}
}

func TestInvalidateAccount(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	openai1 := mustKey(t, "gpt-4o", "openai-chat", g)
	if err := c.Set(context.Background(), openai1, []byte("v"), time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}

	anthropic1, err := NewKey("claude", "anthropic-messages", nil, g, Scope{Provider: "anthropic", AccountID: "acc-an-1"}, NetworkPolicy{}, AffinityNone)
	if err != nil {
		t.Fatalf("NewKey anthropic: %v", err)
	}
	if err := c.Set(context.Background(), anthropic1, []byte("v"), time.Minute); err != nil {
		t.Fatalf("Set anthropic: %v", err)
	}

	removed, err := c.InvalidateAccount(context.Background(), "anthropic", "acc-an-1")
	if err != nil {
		t.Fatalf("InvalidateAccount: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	if _, err := c.Get(context.Background(), openai1); err != nil {
		t.Fatalf("openai entry should survive: %v", err)
	}
	if _, err := c.Get(context.Background(), anthropic1); !errors.Is(err, ErrMiss) {
		t.Fatalf("anthropic entry should be gone: %v", err)
	}
}

func TestInvalidateAll(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	for i := range 5 {
		k, err := NewKey("m-"+string(rune('a'+i)), "openai-chat", nil, g, Scope{Provider: "openai"}, NetworkPolicy{}, AffinityNone)
		if err != nil {
			t.Fatalf("NewKey: %v", err)
		}
		if err := c.Set(context.Background(), k, []byte("v"), time.Minute); err != nil {
			t.Fatalf("Set: %v", err)
		}
	}
	removed, err := c.InvalidateAll(context.Background())
	if err != nil {
		t.Fatalf("InvalidateAll: %v", err)
	}
	if removed != 5 {
		t.Fatalf("removed = %d, want 5", removed)
	}
	if h := c.Health(context.Background()); h.Entries != 0 {
		t.Fatalf("Entries after InvalidateAll = %d, want 0", h.Entries)
	}
}

func TestCapacityBoundEvictsLRU(t *testing.T) {
	c := NewMemory(MemoryConfig{MaxEntries: 2})
	defer c.Close()

	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	k1, err := NewKey("a", "openai-chat", nil, g, Scope{Provider: "openai"}, NetworkPolicy{}, AffinityNone)
	if err != nil {
		t.Fatalf("NewKey k1: %v", err)
	}
	k2, err := NewKey("b", "openai-chat", nil, g, Scope{Provider: "openai"}, NetworkPolicy{}, AffinityNone)
	if err != nil {
		t.Fatalf("NewKey k2: %v", err)
	}
	k3, err := NewKey("c", "openai-chat", nil, g, Scope{Provider: "openai"}, NetworkPolicy{}, AffinityNone)
	if err != nil {
		t.Fatalf("NewKey k3: %v", err)
	}

	if err := c.Set(context.Background(), k1, []byte("1"), time.Minute); err != nil {
		t.Fatalf("Set k1: %v", err)
	}
	if err := c.Set(context.Background(), k2, []byte("2"), time.Minute); err != nil {
		t.Fatalf("Set k2: %v", err)
	}
	// Touch k1 so k2 becomes the LRU victim.
	if _, err := c.Get(context.Background(), k1); err != nil {
		t.Fatalf("Get k1: %v", err)
	}
	if err := c.Set(context.Background(), k3, []byte("3"), time.Minute); err != nil {
		t.Fatalf("Set k3: %v", err)
	}

	if _, err := c.Get(context.Background(), k2); !errors.Is(err, ErrMiss) {
		t.Fatalf("k2 should have been evicted (LRU): %v", err)
	}
	if _, err := c.Get(context.Background(), k1); err != nil {
		t.Fatalf("k1 should still be present: %v", err)
	}
	if _, err := c.Get(context.Background(), k3); err != nil {
		t.Fatalf("k3 should be present: %v", err)
	}
}

func TestCapacityBoundUnboundedIsAccepted(t *testing.T) {
	// MaxEntries=0 means unbounded; verify the documented behaviour explicitly.
	c := NewMemory(MemoryConfig{MaxEntries: 0})
	defer c.Close()

	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	for i := range 100 {
		k, err := NewKey("m"+string(rune('a'+i%26))+"-"+string(rune('a'+i/26)), "openai-chat", nil, g, Scope{Provider: "openai"}, NetworkPolicy{}, AffinityNone)
		if err != nil {
			t.Fatalf("NewKey: %v", err)
		}
		if err := c.Set(context.Background(), k, []byte("v"), time.Minute); err != nil {
			t.Fatalf("Set %d: %v", i, err)
		}
	}
	if h := c.Health(context.Background()); h.Capacity != 0 {
		t.Fatalf("Capacity = %d, want 0", h.Capacity)
	}
}

func TestConcurrentSetGetIsRaceFree(t *testing.T) {
	c := NewMemory(MemoryConfig{MaxEntries: 64})
	defer c.Close()

	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	const writers = 8
	const readers = 8
	const iterations = 250

	var wg sync.WaitGroup
	wg.Add(writers + readers)

	var stop atomic.Bool

	for w := range writers {
		go func(id int) {
			defer wg.Done()
			for range iterations {
				if stop.Load() {
					return
				}
				k, err := NewKey(
					"model-"+string(rune('a'+id)),
					"openai-chat",
					nil,
					g,
					Scope{Provider: "openai"},
					NetworkPolicy{},
					AffinityNone,
				)
				if err != nil {
					t.Errorf("NewKey: %v", err)
					stop.Store(true)
					return
				}
				if err := c.Set(context.Background(), k, []byte("payload"), time.Minute); err != nil {
					t.Errorf("Set: %v", err)
					stop.Store(true)
					return
				}
			}
		}(w)
	}

	for r := range readers {
		go func(id int) {
			defer wg.Done()
			for range iterations {
				if stop.Load() {
					return
				}
				k, err := NewKey(
					"model-"+string(rune('a'+id)),
					"openai-chat",
					nil,
					g,
					Scope{Provider: "openai"},
					NetworkPolicy{},
					AffinityNone,
				)
				if err != nil {
					t.Errorf("NewKey: %v", err)
					stop.Store(true)
					return
				}
				_, _ = c.Get(context.Background(), k)
			}
		}(r)
	}

	wg.Wait()
	h := c.Health(context.Background())
	if h.Misses+h.Hits == 0 {
		t.Fatal("expected non-zero counters")
	}
}

func TestContextCancellationPropagates(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	key := mustKey(t, "gpt-4o", "openai-chat", g)

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Get(cancelled, key); !errors.Is(err, context.Canceled) {
		t.Fatalf("Get with cancelled ctx err = %v, want context.Canceled", err)
	}
	if err := c.Set(cancelled, key, []byte("x"), time.Minute); !errors.Is(err, context.Canceled) {
		t.Fatalf("Set with cancelled ctx err = %v, want context.Canceled", err)
	}
	if err := c.Delete(cancelled, key); !errors.Is(err, context.Canceled) {
		t.Fatalf("Delete with cancelled ctx err = %v, want context.Canceled", err)
	}
}

func TestHealthTransitionsOnlineToOfflineOnClose(t *testing.T) {
	c := NewMemory(MemoryConfig{MaxEntries: 4})
	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}

	if h := c.Health(context.Background()); h.State != HealthOnline {
		t.Fatalf("initial State = %s, want online", h.State)
	}

	key := mustKey(t, "gpt-4o", "openai-chat", g)
	if err := c.Set(context.Background(), key, []byte("v"), time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}
	h := c.Health(context.Background())
	if h.Entries != 1 || h.Capacity != 4 {
		t.Fatalf("Entries=%d Capacity=%d, want 1/4", h.Entries, h.Capacity)
	}
	if h.Hits != 0 || h.Misses != 0 {
		t.Fatalf("initial counters Hits=%d Misses=%d, want 0/0", h.Hits, h.Misses)
	}

	if _, err := c.Get(context.Background(), key); err != nil {
		t.Fatalf("Get: %v", err)
	}
	h = c.Health(context.Background())
	if h.Hits != 1 {
		t.Fatalf("Hits = %d, want 1", h.Hits)
	}

	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if h := c.Health(context.Background()); h.State != HealthOffline {
		t.Fatalf("State after Close = %s, want offline", h.State)
	}
	if h.LastChecked.IsZero() {
		t.Fatal("LastChecked should remain populated after Close")
	}

	// Second Close must be a no-op.
	if err := c.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestOperationsAfterCloseReturnErrClosed(t *testing.T) {
	c := NewMemory(MemoryConfig{})
	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	key := mustKey(t, "gpt-4o", "openai-chat", g)
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := c.Get(context.Background(), key); !errors.Is(err, ErrClosed) {
		t.Fatalf("Get err = %v, want ErrClosed", err)
	}
	if err := c.Set(context.Background(), key, []byte("v"), time.Minute); !errors.Is(err, ErrClosed) {
		t.Fatalf("Set err = %v, want ErrClosed", err)
	}
	if err := c.Delete(context.Background(), key); !errors.Is(err, ErrClosed) {
		t.Fatalf("Delete err = %v, want ErrClosed", err)
	}
	if _, err := c.InvalidateAll(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("InvalidateAll err = %v, want ErrClosed", err)
	}
}

func TestMissCoalescingRunsLoaderOnce(t *testing.T) {
	c := NewMemory(MemoryConfig{MaxInFlight: 8})
	defer c.Close()

	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	key := mustKey(t, "gpt-4o", "openai-chat", g)

	var calls atomic.Int32
	loader := func(ctx context.Context, k Key) (Entry, error) {
		calls.Add(1)
		// Yield to ensure concurrent callers actually pile up on the flight.
		time.Sleep(20 * time.Millisecond)
		return Entry{
			Key:        k,
			Value:      []byte("resolved"),
			StoredAt:   time.Now(),
			ExpiresAt:  time.Now().Add(time.Minute),
			Generation: k.Generation,
			Remaining:  time.Minute,
		}, nil
	}

	const waiters = 16
	var wg sync.WaitGroup
	wg.Add(waiters)
	results := make([]Entry, waiters)
	errs := make([]error, waiters)
	for i := range waiters {
		go func(idx int) {
			defer wg.Done()
			results[idx], errs[idx] = c.GetOrLoad(context.Background(), key, loader)
		}(i)
	}
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Fatalf("loader calls = %d, want 1", got)
	}
	for i, e := range results {
		if errs[i] != nil {
			t.Fatalf("waiter %d err = %v", i, errs[i])
		}
		if !bytes.Equal(e.Value, []byte("resolved")) {
			t.Fatalf("waiter %d value = %q", i, e.Value)
		}
	}

	// After the flight resolves, Get should observe the cached value (loader
	// result was cached with the default TTL).
	got, err := c.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("Get after GetOrLoad: %v", err)
	}
	if !bytes.Equal(got.Value, []byte("resolved")) {
		t.Fatalf("cached value = %q, want %q", got.Value, "resolved")
	}
}

func TestMissCoalescingCancellation(t *testing.T) {
	c := NewMemory(MemoryConfig{MaxInFlight: 1})
	defer c.Close()

	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	key := mustKey(t, "gpt-4o", "openai-chat", g)

	started := make(chan struct{})
	released := make(chan struct{})
	loader := func(ctx context.Context, k Key) (Entry, error) {
		close(started)
		select {
		case <-ctx.Done():
			return Entry{Key: k, Generation: k.Generation}, ctx.Err()
		case <-released:
			return Entry{Key: k, Value: []byte("v"), Generation: k.Generation, ExpiresAt: time.Now().Add(time.Minute)}, nil
		}
	}

	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()

	doneCh := make(chan error, 1)
	go func() {
		_, err := c.GetOrLoad(ctx1, key, loader)
		doneCh <- err
	}()

	<-started
	cancel1()

	select {
	case err := <-doneCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("leader err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("leader did not return after cancellation")
	}
	close(released)
}

func TestMissCoalescingSurfacesLoaderErrorToAllWaiters(t *testing.T) {
	c := NewMemory(MemoryConfig{MaxInFlight: 8})
	defer c.Close()

	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	key := mustKey(t, "gpt-4o", "openai-chat", g)

	want := errors.New("upstream-down")
	loader := func(ctx context.Context, k Key) (Entry, error) {
		time.Sleep(20 * time.Millisecond)
		return Entry{}, want
	}

	const waiters = 4
	var wg sync.WaitGroup
	wg.Add(waiters)
	errs := make([]error, waiters)
	for i := range waiters {
		go func(idx int) {
			defer wg.Done()
			_, errs[idx] = c.GetOrLoad(context.Background(), key, loader)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if !errors.Is(err, want) {
			t.Fatalf("waiter %d err = %v, want %v", i, err, want)
		}
	}
}

func TestMissCoalescingBusyWhenAtCapacity(t *testing.T) {
	c := NewMemory(MemoryConfig{MaxInFlight: 1})
	defer c.Close()

	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	keyA := mustKey(t, "a", "openai-chat", g)
	keyB := mustKey(t, "b", "openai-chat", g)

	started := make(chan struct{})
	released := make(chan struct{})
	loaderA := func(ctx context.Context, k Key) (Entry, error) {
		close(started)
		<-released
		return Entry{Key: k, Value: []byte("a"), Generation: k.Generation, ExpiresAt: time.Now().Add(time.Minute)}, nil
	}

	doneCh := make(chan error, 1)
	go func() {
		_, err := c.GetOrLoad(context.Background(), keyA, loaderA)
		doneCh <- err
	}()
	<-started

	// Different key with MaxInFlight=1 must surface ErrBusy rather than start
	// a second loader.
	_, err := c.GetOrLoad(context.Background(), keyB, func(ctx context.Context, k Key) (Entry, error) {
		t.Fatalf("loader for keyB must not be invoked when coalescer is busy")
		return Entry{}, nil
	})
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v, want ErrBusy", err)
	}

	close(released)
	if err := <-doneCh; err != nil {
		t.Fatalf("leader err: %v", err)
	}
}

func TestCloseWakesInflightWaitersWithErrClosed(t *testing.T) {
	c := NewMemory(MemoryConfig{MaxInFlight: 4})
	g := Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}
	key := mustKey(t, "gpt-4o", "openai-chat", g)

	started := make(chan struct{})
	loader := func(ctx context.Context, k Key) (Entry, error) {
		close(started)
		<-ctx.Done()
		return Entry{}, ctx.Err()
	}

	leaderDone := make(chan error, 1)
	go func() {
		_, err := c.GetOrLoad(context.Background(), key, loader)
		leaderDone <- err
	}()
	<-started

	waiterDone := make(chan error, 1)
	go func() {
		_, err := c.GetOrLoad(context.Background(), key, loader)
		waiterDone <- err
	}()
	// Give the waiter a moment to register on the in-flight map.
	time.Sleep(10 * time.Millisecond)

	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	select {
	case err := <-waiterDone:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("waiter err = %v, want ErrClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waiter did not return after Close")
	}
	select {
	case err := <-leaderDone:
		// Leader's loader returns ctx.Err. ErrClosed wins when the backend
		// was closed; either ErrClosed or context error is acceptable as
		// long as the call unblocks.
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, ErrClosed) {
			t.Fatalf("leader err = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("leader did not return after Close")
	}
}

func TestKeyWireRejectsUnsupportedVersion(t *testing.T) {
	// Older versions produce a wire fingerprint but Get/Set reject them
	// with ErrInvalidKey so callers cannot accidentally mix layouts.
	c := NewMemory(MemoryConfig{})
	defer c.Close()

	old := Key{
		Version:    99,
		Model:      "gpt-4o",
		Surface:    "openai-chat",
		Generation: Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1},
		Scope:      Scope{Provider: "openai"},
	}
	if err := c.Set(context.Background(), old, []byte("x"), time.Minute); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("Set with unknown version err = %v, want ErrInvalidKey", err)
	}
}
