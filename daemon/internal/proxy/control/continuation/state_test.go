package continuation

import (
	"context"
	"errors"
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
	if _, err := s.Resolve(context.Background(), "missing", "tenant-a", "openai"); !errors.Is(err, ErrNotFound) || CodeOf(err) != CodeNotFound {
		t.Fatalf("unknown err=%v code=%q", err, CodeOf(err))
	}
}

func TestStoreAuthorizationCancellationAndClosedErrors(t *testing.T) {
	s := New(time.Minute)
	state := State{
		ID: "resp-auth", ResponseID: "upstream-auth", Scope: "tenant-a",
		Provider: "openai", Model: "gpt-4o", ExpiresAt: time.Now().Add(time.Minute),
	}
	if err := s.Put(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResolveFor(context.Background(), state.ID, Binding{Provider: "openai", Model: "gpt-4o"}); !errors.Is(err, ErrUnauthorized) || CodeOf(err) != CodeUnauthorized {
		t.Fatalf("missing authorization err=%v code=%q", err, CodeOf(err))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Put(ctx, State{ID: "canceled", ResponseID: "canceled", Scope: "tenant-a", Provider: "openai"}); !errors.Is(err, ErrCanceled) || CodeOf(err) != CodeCanceled {
		t.Fatalf("canceled put err=%v code=%q", err, CodeOf(err))
	}
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Resolve(context.Background(), state.ID, "tenant-a", "openai"); !errors.Is(err, ErrClosed) || CodeOf(err) != CodeClosed {
		t.Fatalf("closed resolve err=%v code=%q", err, CodeOf(err))
	}
}

func TestStoreRestartSafeWithSharedPersistence(t *testing.T) {
	persistence := NewMemoryPersistence()
	first := NewWithPersistence(time.Minute, persistence)
	state := State{
		ID: "resp-restart", ResponseID: "upstream-restart", Scope: "tenant-a",
		Provider: "openai", Model: "gpt-4o", Generation: 3,
		ExpiresAt: time.Now().Add(time.Minute),
	}
	if err := first.Put(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	second := NewWithPersistence(time.Minute, persistence)
	resolved, err := second.ResolveFor(context.Background(), state.ID, Binding{
		Scope: "tenant-a", Provider: "openai", Model: "gpt-4o", Generation: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.ResponseID != state.ResponseID {
		t.Fatalf("response id=%q, want %q", resolved.ResponseID, state.ResponseID)
	}
}

func TestStoreCleanupIsBounded(t *testing.T) {
	s := New(time.Minute)
	for i := range 3 {
		state := State{
			ID: "expired-" + string(rune('a'+i)), ResponseID: "upstream",
			Scope: "tenant-a", Provider: "openai", ExpiresAt: time.Now().Add(-time.Second),
		}
		if err := s.Put(context.Background(), state); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := s.Cleanup(context.Background(), 2)
	if err != nil || removed != 2 {
		t.Fatalf("first cleanup removed=%d err=%v", removed, err)
	}
	removed, err = s.Cleanup(context.Background(), 2)
	if err != nil || removed != 1 {
		t.Fatalf("second cleanup removed=%d err=%v", removed, err)
	}
}

func TestStoreRepairCannotSubstituteUnrelatedHistory(t *testing.T) {
	persistence := NewMemoryPersistence()
	s := NewWithPersistence(time.Minute, persistence)
	stale := State{
		ID: "resp-stale", ResponseID: "upstream-stale", Scope: "tenant-a",
		Provider: "openai", Model: "gpt-4o", Generation: 1,
		ExpiresAt: time.Now().Add(time.Minute),
	}
	unrelated := State{
		ID: "other", ResponseID: "upstream-other", Scope: "tenant-a",
		Provider: "openai", Model: "gpt-4o", Generation: 2,
		ExpiresAt: time.Now().Add(time.Minute),
	}
	if err := s.Put(context.Background(), stale); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(context.Background(), unrelated); err != nil {
		t.Fatal(err)
	}
	_, err := s.ResolveWithPolicy(context.Background(), stale.ID, Binding{
		Scope: "tenant-a", Provider: "openai", Model: "gpt-4o", Generation: 2,
	}, RepairPolicy{
		MaxAttempts: 1,
		Repair: func(context.Context, State, Binding) (State, error) {
			return unrelated, nil
		},
	})
	if !errors.Is(err, ErrRepair) || CodeOf(err) != CodeRepair {
		t.Fatalf("substitution err=%v code=%q", err, CodeOf(err))
	}
}

func TestStoreBoundedExactRepair(t *testing.T) {
	s := New(time.Minute)
	state := State{
		ID: "resp-repair", ResponseID: "upstream-repair", Scope: "tenant-a",
		Provider: "openai", Model: "gpt-4o", Generation: 1,
		ExpiresAt: time.Now().Add(time.Minute),
	}
	if err := s.Put(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	resolved, err := s.ResolveWithPolicy(context.Background(), state.ID, Binding{
		Scope: "tenant-a", Provider: "openai", Model: "gpt-4o", Generation: 2,
	}, RepairPolicy{
		MaxAttempts: 1,
		Repair: func(_ context.Context, current State, binding Binding) (State, error) {
			current.Generation = binding.Generation
			return current, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Generation != 2 || resolved.ID != state.ID {
		t.Fatalf("repaired state=%+v", resolved)
	}
}

type failingPersistence struct{}

func (failingPersistence) Put(context.Context, State) error {
	return errors.New("disk unavailable")
}
func (failingPersistence) Load(context.Context, string) (State, error) {
	return State{}, errors.New("disk unavailable")
}
func (failingPersistence) Delete(context.Context, string) error {
	return errors.New("disk unavailable")
}
func (failingPersistence) Sweep(context.Context, time.Time, int) (int, error) {
	return 0, errors.New("disk unavailable")
}

func TestStorePersistenceFailuresHaveStableCode(t *testing.T) {
	s := NewWithPersistence(time.Minute, failingPersistence{})
	err := s.Put(context.Background(), State{
		ID: "disk", ResponseID: "disk", Scope: "tenant-a", Provider: "openai",
	})
	if !errors.Is(err, ErrPersistence) || CodeOf(err) != CodePersistence {
		t.Fatalf("put err=%v code=%q", err, CodeOf(err))
	}
}
