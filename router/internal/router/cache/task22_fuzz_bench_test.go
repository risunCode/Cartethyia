package cache

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func FuzzTask22CacheKeysNoCollisionPanic(f *testing.F) {
	f.Add("fixture-model", "openai-chat", "openai", "default", "", uint8(1))
	f.Add("fixture-model", "openai-responses", "openai", "compliance", "edge", uint8(2))
	f.Fuzz(func(t *testing.T, model, surface, provider, profile, egress string, variant uint8) {
		if len(model) > 256 {
			model = model[:256]
		}
		if len(surface) > 256 {
			surface = surface[:256]
		}
		if len(provider) > 256 {
			provider = provider[:256]
		}
		if len(profile) > 256 {
			profile = profile[:256]
		}
		if len(egress) > 256 {
			egress = egress[:256]
		}
		base, err := NewKey(model, surface, []CapabilityRequirement{"text", "streaming"}, Generation{Catalog: 1 + uint64(variant%2)}, Scope{Provider: provider}, NetworkPolicy{Profile: profile, Egress: egress}, AffinityNone)
		if err != nil {
			return
		}
		changed := base
		changed.Affinity = AffinityStrong
		if base.Wire() == changed.Wire() {
			t.Fatal("affinity changed but cache wire did not")
		}
		permuted, err := NewKey(model, surface, []CapabilityRequirement{"streaming", "text"}, base.Generation, base.Scope, base.Network, changed.Affinity)
		if err != nil {
			return
		}
		if changed.Wire() != permuted.Wire() {
			t.Fatal("capability ordering changed cache wire")
		}
	})
}

// task22WaiterContext reports when GetOrLoad has reached waitForFlight. Its
// Done method is called only after the caller has observed the existing flight,
// so the benchmark can release the loader without racing waiter registration.
type task22WaiterContext struct {
	joined chan<- struct{}
	once   sync.Once
}

func (c *task22WaiterContext) Deadline() (time.Time, bool) { return time.Time{}, false }
func (c *task22WaiterContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.joined) })
	return nil
}
func (*task22WaiterContext) Err() error    { return nil }
func (*task22WaiterContext) Value(any) any { return nil }

func BenchmarkTask22CacheMemoryHit(b *testing.B) {
	cache := NewMemory(MemoryConfig{MaxEntries: 8, MaxBytes: 4096})
	defer cache.Close()
	key, err := NewKey("fixture-model", "openai-chat", []CapabilityRequirement{"text"}, Generation{Catalog: 1}, Scope{Provider: "fixture"}, NetworkPolicy{}, AffinityNone)
	if err != nil {
		b.Fatal(err)
	}
	if err := cache.Set(context.Background(), key, []byte("fixture-value"), time.Minute); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := cache.Get(context.Background(), key); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTask22CacheMemoryMiss(b *testing.B) {
	cache := NewMemory(MemoryConfig{MaxEntries: 8, MaxInFlight: 2, MaxBytes: 4096})
	defer cache.Close()
	key, err := NewKey("fixture-miss-model", "openai-chat", []CapabilityRequirement{"text"}, Generation{Catalog: 1}, Scope{Provider: "fixture"}, NetworkPolicy{}, AffinityNone)
	if err != nil {
		b.Fatal(err)
	}
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		if _, err := cache.Get(ctx, key); err == nil {
			b.Fatal("memory miss unexpectedly returned a hit")
		}
	}
}

func BenchmarkTask22CacheMemoryCoalescing(b *testing.B) {
	cache := NewMemory(MemoryConfig{MaxEntries: 8, MaxInFlight: 2, MaxBytes: 4096})
	defer cache.Close()
	key, err := NewKey("fixture-coalesced-model", "openai-chat", []CapabilityRequirement{"text"}, Generation{Catalog: 1}, Scope{Provider: "fixture"}, NetworkPolicy{}, AffinityNone)
	if err != nil {
		b.Fatal(err)
	}
	ctx := context.Background()
	loader := func(started chan<- struct{}, release <-chan struct{}) Loader {
		return func(ctx context.Context, key Key) (Entry, error) {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return Entry{}, ctx.Err()
			}
			return Entry{Key: key, Value: []byte("fixture-value"), Generation: key.Generation}, nil
		}
	}
	b.ReportAllocs()
	for b.Loop() {
		if err := cache.Delete(ctx, key); err != nil {
			b.Fatal(err)
		}
		started := make(chan struct{})
		release := make(chan struct{})
		leaderDone := make(chan error, 1)
		go func() {
			_, loadErr := cache.GetOrLoad(ctx, key, loader(started, release))
			leaderDone <- loadErr
		}()
		<-started
		waiterJoined := make(chan struct{})
		waiterDone := make(chan error, 1)
		go func() {
			waiterCtx := &task22WaiterContext{joined: waiterJoined}
			_, waitErr := cache.GetOrLoad(waiterCtx, key, func(context.Context, Key) (Entry, error) {
				return Entry{}, errors.New("coalescing waiter unexpectedly became loader")
			})
			waiterDone <- waitErr
		}()
		timer := time.NewTimer(time.Second)
		select {
		case <-waiterJoined:
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
			b.Fatal("coalescing waiter did not join in-flight flight")
		}
		close(release)
		if err := <-leaderDone; err != nil {
			b.Fatal(err)
		}
		if err := <-waiterDone; err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTask22ResponseCacheHit(b *testing.B) {
	backend := NewMemory(MemoryConfig{MaxEntries: 8, MaxBytes: 4096})
	defer backend.Close()
	responses, err := NewResponseCache(backend, true, time.Minute)
	if err != nil {
		b.Fatal(err)
	}
	spec := ResponseSpec{TenantID: "fixture-tenant", SourceSurface: "openai-chat", TargetSurface: "openai-chat", Provider: "fixture", Model: "fixture-model", RequestBodyDigest: "fixture-digest", Generation: Generation{Catalog: 1}, Complete: true}
	ctx := context.Background()
	if err := responses.Set(ctx, spec, []byte(`{"ok":true}`)); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := responses.Get(ctx, spec); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTask22ResponseCacheMiss(b *testing.B) {
	backend := NewMemory(MemoryConfig{MaxEntries: 8, MaxBytes: 4096})
	defer backend.Close()
	responses, err := NewResponseCache(backend, true, time.Minute)
	if err != nil {
		b.Fatal(err)
	}
	spec := ResponseSpec{TenantID: "fixture-tenant", SourceSurface: "openai-chat", TargetSurface: "openai-chat", Provider: "fixture", Model: "fixture-model", RequestBodyDigest: "fixture-miss-digest", Generation: Generation{Catalog: 1}, Complete: true}
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		if _, err := responses.Get(ctx, spec); err == nil {
			b.Fatal("response cache miss unexpectedly returned a hit")
		}
	}
}

func BenchmarkTask22SharedContentEnvelope(b *testing.B) {
	backend := NewMemory(MemoryConfig{MaxEntries: 8, MaxBytes: 64 * 1024})
	defer backend.Close()
	store, err := NewSharedContentStore(backend, []byte("fixture-process-key"), 16*1024, time.Hour)
	if err != nil {
		b.Fatal(err)
	}
	spec := SharedContentSpec{TenantID: "fixture-tenant", Namespace: "response", Identity: "fixture-identity", Provider: "fixture-provider", Model: "fixture-model", Surface: "openai-chat", Generation: Generation{Catalog: 1}}
	value := []byte(`{"status":"completed","text":"fixture"}`)
	if err := store.Set(context.Background(), spec, value); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := store.Get(context.Background(), spec); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTask22CacheKeyFingerprint(b *testing.B) {
	key, err := NewKey("fixture-model", "openai-chat", []CapabilityRequirement{"text", "streaming", "reasoning"}, Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}, Scope{Provider: "fixture", AccountID: "fixture-account"}, NetworkPolicy{Profile: "default", Egress: "fixture"}, AffinityStrong)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if len(key.Wire()) != 64 {
			b.Fatal("cache fingerprint has unexpected length")
		}
	}
}

func BenchmarkTask22CacheRouterFallbackHit(b *testing.B) {
	fallback := NewMemory(MemoryConfig{MaxEntries: 8, MaxBytes: 4096})
	router, err := NewRouter(nil, fallback)
	if err != nil {
		b.Fatal(err)
	}
	defer router.Close()
	key, err := NewKey("fixture-model", "openai-chat", []CapabilityRequirement{"text"}, Generation{Catalog: 1}, Scope{Provider: "fixture"}, NetworkPolicy{}, AffinityNone)
	if err != nil {
		b.Fatal(err)
	}
	ctx := context.Background()
	if err := router.Set(ctx, key, []byte("fixture-value"), time.Minute); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := router.Get(ctx, key); err != nil {
			b.Fatal(err)
		}
	}
}
