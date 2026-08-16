package continuation

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestStoreEnforcesScopeProviderAndExpiry(t *testing.T) {
	s := New(time.Minute)
	state := State{ID: "resp-1", ResponseID: "resp-1", Scope: "client-1", Provider: "openai-responses", ExpiresAt: time.Now().Add(time.Minute)}
	if err := s.Put(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Resolve(context.Background(), "resp-1", "other", "openai-responses"); !errors.Is(err, ErrScope) {
		t.Fatalf("scope err=%v", err)
	}
	if _, err := s.Resolve(context.Background(), "resp-1", "client-1", "anthropic"); !errors.Is(err, ErrProvider) {
		t.Fatalf("provider err=%v", err)
	}
	state.ExpiresAt = time.Now().Add(-time.Second)
	s.Delete(context.Background(), "resp-1")
	if _, err := s.Resolve(context.Background(), "resp-1", "client-1", "openai-responses"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing err=%v", err)
	}
}

func TestStoreExpiredStateIsTypedAndRemoved(t *testing.T) {
	s := New(time.Minute)
	state := State{
		ID: "expired", ResponseID: "expired", Scope: "tenant-a", Provider: "openai",
		ExpiresAt: time.Now().Add(-time.Second),
	}
	if err := s.Put(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Resolve(context.Background(), state.ID, state.Scope, state.Provider); !errors.Is(err, ErrExpired) || CodeOf(err) != CodeExpired {
		t.Fatalf("expired err=%v code=%q", err, CodeOf(err))
	}
	if _, err := s.Resolve(context.Background(), state.ID, state.Scope, state.Provider); !errors.Is(err, ErrNotFound) || CodeOf(err) != CodeNotFound {
		t.Fatalf("removed err=%v code=%q", err, CodeOf(err))
	}
}

func TestStoreRejectsUnknownModelAndStaleGeneration(t *testing.T) {
	s := New(time.Minute)
	state := State{
		ID: "resp-model", ResponseID: "upstream-model", Scope: "tenant-a",
		Provider: "openai", Model: "gpt-4o", Generation: 7,
		ExpiresAt: time.Now().Add(time.Minute),
	}
	if err := s.Put(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResolveFor(context.Background(), state.ID, Binding{
		Scope: "tenant-a", Provider: "openai", Model: "gpt-4o-mini", Generation: 7,
	}); !errors.Is(err, ErrModel) || CodeOf(err) != CodeModel {
		t.Fatalf("model err=%v code=%q", err, CodeOf(err))
	}
	if _, err := s.ResolveFor(context.Background(), state.ID, Binding{
		Scope: "tenant-a", Provider: "openai", Model: "gpt-4o", Generation: 8,
	}); !errors.Is(err, ErrGeneration) || CodeOf(err) != CodeGeneration {
		t.Fatalf("generation err=%v code=%q", err, CodeOf(err))
	}
}

func TestContinuationErrorAndHelpers(t *testing.T) {
	var nilErr *Error
	if nilErr.Error() != "" || nilErr.Unwrap() != nil {
		t.Fatalf("nil error: %q", nilErr.Error())
	}
	underlying := errors.New("underlying cause")
	e := &Error{Code: CodeNotFound, Message: "not found message", Err: underlying}
	if !strings.Contains(e.Error(), "not found message") || !strings.Contains(e.Error(), "underlying cause") {
		t.Fatalf("e.Error = %q", e.Error())
	}
	if !errors.Is(e, underlying) {
		t.Fatal("unwrap failed")
	}
	if !errors.Is(e, ErrNotFound) {
		t.Fatal("error code match failed")
	}

	// CodeOf
	if CodeOf(nil) != "" {
		t.Fatal("nil error code non-empty")
	}
	if CodeOf(context.Canceled) != CodeCanceled {
		t.Fatalf("canceled code = %v", CodeOf(context.Canceled))
	}
	if CodeOf(context.DeadlineExceeded) != CodeCanceled {
		t.Fatalf("deadline code = %v", CodeOf(context.DeadlineExceeded))
	}
	if CodeOf(errors.New("unrelated")) != "" {
		t.Fatalf("unrelated code = %v", CodeOf(errors.New("unrelated")))
	}

	// NewID
	id, err := NewID()
	if err != nil || len(id) == 0 {
		t.Fatalf("NewID = %q, %v", id, err)
	}
}

func TestStorePersistentAndSweep(t *testing.T) {
	mem := NewMemoryPersistence()
	s := NewPersistent(time.Minute, mem)
	s.SetMaxCleanup(100)
	s.SetRepairPolicy(RepairPolicy{MaxAttempts: 2})

	ctx := context.Background()
	now := time.Now()
	expiredState := State{
		ID:         "exp-1",
		ResponseID: "resp-exp",
		Scope:      "tenant",
		Provider:   "openai",
		ExpiresAt:  now.Add(-time.Minute),
	}
	activeState := State{
		ID:         "act-1",
		ResponseID: "resp-act",
		Scope:      "tenant",
		Provider:   "openai",
		ExpiresAt:  now.Add(time.Minute),
	}
	if err := s.Put(ctx, expiredState); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ctx, activeState); err != nil {
		t.Fatal(err)
	}

	// Sweep
	n := s.Sweep(now)
	if n != 1 {
		t.Fatalf("Sweep removed %d items, want 1", n)
	}

	// Cleanup
	cleaned, err := s.Cleanup(ctx, 10)
	if err != nil {
		t.Fatalf("Cleanup err = %v", err)
	}
	_ = cleaned

	// Close store
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ctx, activeState); !errors.Is(err, ErrClosed) {
		t.Fatalf("put after close err = %v, want ErrClosed", err)
	}
}
