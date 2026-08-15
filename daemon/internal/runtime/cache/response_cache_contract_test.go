package cache

import (
	"context"
	"errors"
	"testing"
	"time"
)

func responseContractSpec() ResponseSpec {
	return ResponseSpec{TenantID: "tenant", SourceSurface: "openai-chat", TargetSurface: "openai-chat", Provider: "openai", Model: "model", RequestBodyDigest: "request", Generation: Generation{Catalog: 1, Credentials: 1, Health: 1, Network: 1}, Complete: true}
}

func TestResponseCacheSetValidatedRequiresCompleteEncoderValidation(t *testing.T) {
	backend := NewMemory(MemoryConfig{MaxEntries: 4, MaxBytes: 4096})
	defer backend.Close()
	responses, err := NewResponseCache(backend, true, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	spec := responseContractSpec()
	if err := responses.SetValidated(context.Background(), spec, []byte(`{"ok":true}`), nil); !errors.Is(err, ErrResponseCacheIneligible) {
		t.Fatalf("nil validator error=%v", err)
	}
	bad := spec
	bad.Complete = false
	if err := responses.SetValidated(context.Background(), bad, []byte(`{"ok":true}`), func([]byte) error { return nil }); !errors.Is(err, ErrResponseCacheIneligible) {
		t.Fatalf("incomplete error=%v", err)
	}
	if err := responses.SetValidated(context.Background(), spec, []byte(`not-json`), func([]byte) error { return errors.New("invalid") }); !errors.Is(err, ErrResponseCacheIneligible) {
		t.Fatalf("invalid error=%v", err)
	}
}

func TestResponseCacheEncryptedHitHasNoProviderDependency(t *testing.T) {
	backend := NewMemory(MemoryConfig{MaxEntries: 4, MaxBytes: 4096})
	defer backend.Close()
	responses, err := NewResponseCache(backend, true, time.Minute, []byte("cache-encryption-key"))
	if err != nil {
		t.Fatal(err)
	}
	spec := responseContractSpec()
	body := []byte(`{"id":"complete"}`)
	if err := responses.SetValidated(context.Background(), spec, body, func(value []byte) error {
		if len(value) == 0 {
			return errors.New("empty")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	got, err := responses.Get(context.Background(), spec)
	if err != nil || string(got.Value) != string(body) {
		t.Fatalf("get=(%q,%v)", got.Value, err)
	}
}
