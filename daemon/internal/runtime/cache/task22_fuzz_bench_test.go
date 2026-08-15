package cache

import (
	"context"
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
