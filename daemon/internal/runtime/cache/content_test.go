package cache

import (
	"context"
	"errors"
	"testing"
	"time"
)

type contentClock struct{ now time.Time }

func (c *contentClock) Now() time.Time { return c.now }

func testSharedSpec(g Generation) SharedContentSpec {
	return SharedContentSpec{TenantID: "tenant-a", Namespace: "responses", Identity: "request-digest", Provider: "openai", Model: "model", Surface: "openai-chat", Generation: g}
}

func TestSharedContentEncryptsAndSeparatesTenants(t *testing.T) {
	clock := &contentClock{now: time.Unix(100, 0)}
	backend := NewMemory(MemoryConfig{MaxEntries: 8, MaxBytes: 4096, Clock: clock.Now})
	defer backend.Close()
	store, err := NewSharedContentStore(backend, []byte("process-encryption-key"), 1024, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	spec := testSharedSpec(Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1})
	plain := []byte("private-response")
	if err := store.Set(context.Background(), spec, plain); err != nil {
		t.Fatal(err)
	}
	key, _ := store.key(spec)
	raw, err := backend.Get(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw.Value) == string(plain) {
		t.Fatal("shared content was stored in plaintext")
	}
	got, err := store.Get(context.Background(), spec)
	if err != nil || string(got.Value) != string(plain) {
		t.Fatalf("get=(%q,%v)", got.Value, err)
	}
	other := spec
	other.TenantID = "tenant-b"
	if _, err := store.Get(context.Background(), other); !errors.Is(err, ErrMiss) {
		t.Fatalf("cross-tenant error=%v", err)
	}
}

func TestSharedContentExpiryGenerationAndDelete(t *testing.T) {
	clock := &contentClock{now: time.Unix(200, 0)}
	backend := NewMemory(MemoryConfig{MaxEntries: 8, Clock: clock.Now})
	defer backend.Close()
	store, err := NewSharedContentStore(backend, []byte("another-process-key"), 1024, 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	spec := testSharedSpec(Generation{Catalog: 2, Credentials: 1, Health: 1, Network: 1})
	if err := store.Set(context.Background(), spec, []byte("value")); err != nil {
		t.Fatal(err)
	}
	stale := spec
	stale.Generation.Catalog++
	if _, err := store.Get(context.Background(), stale); !errors.Is(err, ErrGenerationMismatch) {
		t.Fatalf("generation error=%v", err)
	}
	clock.now = clock.now.Add(3 * time.Minute)
	if _, err := store.Get(context.Background(), spec); !errors.Is(err, ErrMiss) {
		t.Fatalf("expiry error=%v", err)
	}
	if err := store.Set(context.Background(), spec, []byte("value")); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(context.Background(), spec); !errors.Is(err, ErrMiss) {
		t.Fatalf("delete error=%v", err)
	}
}

func TestSharedContentCapsBytesAndTTL(t *testing.T) {
	backend := NewMemory(MemoryConfig{MaxEntries: 4, MaxBytes: 256})
	defer backend.Close()
	store, err := NewSharedContentStore(backend, []byte("bounded-key"), 4, 2*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	spec := testSharedSpec(Generation{Catalog: 3, Credentials: 1, Health: 1, Network: 1})
	if err := store.Set(context.Background(), spec, []byte("12345")); !errors.Is(err, ErrContentTooLarge) {
		t.Fatalf("oversize error=%v", err)
	}
	if store.ttl != MaxSharedContentTTL {
		t.Fatalf("ttl=%v", store.ttl)
	}
}
