package cache

import (
	"context"
	"testing"

	"time"
)

func TestResponseCacheRejectsUnsafeEligibility(t *testing.T) {
	backend := NewMemory(MemoryConfig{MaxEntries: 4, MaxBytes: 1024})
	defer backend.Close()
	response, err := NewResponseCache(backend, true, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	spec := ResponseSpec{TenantID: "tenant-a", Provider: "openai", Model: "gpt-5", RequestBodyDigest: "digest", Streaming: true}
	if _, err := response.Get(context.Background(), spec); err != ErrResponseCacheIneligible {
		t.Fatalf("error = %v, want ineligible", err)
	}
}

func TestResponseCacheSeparatesTenantsAndCopiesBody(t *testing.T) {
	backend := NewMemory(MemoryConfig{MaxEntries: 4, MaxBytes: 1024})
	defer backend.Close()
	response, err := NewResponseCache(backend, true, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	base := ResponseSpec{Provider: "openai", Model: "gpt-5", SourceSurface: "openai-chat", TargetSurface: "openai-responses", RequestBodyDigest: "digest", Generation: Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}}
	body := []byte(`{"ok":true}`)
	a := base
	a.TenantID = "tenant-a"
	b := base
	b.TenantID = "tenant-b"
	if err := response.Set(context.Background(), a, body); err != nil {
		t.Fatal(err)
	}
	body[0] = 'x'
	entry, err := response.Get(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	if string(entry.Value) != `{"ok":true}` {
		t.Fatalf("body = %q", entry.Value)
	}
	if _, err := response.Get(context.Background(), b); err == nil {
		t.Fatal("cross-tenant response cache hit")
	}
}
