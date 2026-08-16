package cache

import (
	"context"
	"errors"
	"testing"
	"time"
)

type invalidatingRemote struct {
	*RedisBackend
	generationCalls int
	accountCalls    int
	allCalls        int
}

func (r *invalidatingRemote) InvalidateGeneration(context.Context, Generation) (int, error) {
	r.generationCalls++
	return 2, nil
}
func (r *invalidatingRemote) InvalidateAccount(context.Context, string, string) (int, error) {
	r.accountCalls++
	return 3, nil
}
func (r *invalidatingRemote) InvalidateAll(context.Context) (int, error) {
	r.allCalls++
	return 4, nil
}

func TestGenerationFormattingAndMatching(t *testing.T) {
	g := Generation{Catalog: 1, Credentials: 23, Health: 456, Network: 7890}
	if got, want := g.wire(), "gen=c0001/cr0023/h0456/n7890"; got != want {
		t.Fatalf("wire=%q, want %q", got, want)
	}
	if got, want := g.String(), "catalog=1/credentials=23/health=456/network=7890"; got != want {
		t.Fatalf("String=%q, want %q", got, want)
	}
	if !g.Equal(g) || !MatchesGeneration(g, g) || g.Equal(Generation{}) || MatchesGeneration(g, Generation{}) {
		t.Fatal("generation equality/matching incorrect")
	}
	if !(Generation{}).IsZero() {
		t.Fatal("zero generation should be zero")
	}
	if g.IsZero() {
		t.Fatal("non-zero generation reported zero")
	}
}

func TestHealthUsability(t *testing.T) {
	if !(Health{State: HealthOnline}.IsUsable()) {
		t.Fatal("online health should be usable")
	}
	for _, state := range []HealthState{HealthOffline, HealthUnhealthy, "unknown"} {
		if (Health{State: state}).IsUsable() {
			t.Fatalf("state %q should not be usable", state)
		}
	}
}

func TestBackendErrorAndMissFormatting(t *testing.T) {
	cause := errors.New("cause")
	be := &BackendError{Code: ErrRemoteCommand, Op: "get", Err: cause}
	if got, want := be.Error(), "cache: remote command failed: get: cause"; got != want {
		t.Fatalf("backend error=%q, want %q", got, want)
	}
	if !errors.Is(be, ErrRemoteCommand) || !errors.Is(be, cause) || !errors.Is(be, cause) {
		t.Fatal("backend error Is/Unwrap mismatch")
	}
	if got := (&BackendError{Code: ErrRemoteCommand}).Error(); got != ErrRemoteCommand.Error() {
		t.Fatalf("empty backend error=%q", got)
	}
	if got := (*BackendError)(nil).Error(); got != "<nil>" {
		t.Fatalf("nil backend error=%q", got)
	}
	if got := (&MissError{Reason: "unavailable"}).Error(); got != "cache: miss: unavailable" {
		t.Fatalf("miss error=%q", got)
	}
	if !errors.Is(&MissError{}, ErrMiss) || !errors.Is(&GenerationMismatchError{}, ErrGenerationMismatch) {
		t.Fatal("typed miss matching failed")
	}
}

func TestRouterDeleteAndInvalidations(t *testing.T) {
	client := newFakeRemote()
	backend, err := NewRedisBackend(client, RedisConfig{})
	if err != nil {
		t.Fatal(err)
	}
	remote := &invalidatingRemote{RedisBackend: backend}
	fallback := NewMemory(MemoryConfig{})
	router, err := NewRouter(remote, fallback)
	if err != nil {
		t.Fatal(err)
	}
	defer router.Close()
	if err := router.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	key := redisTestKey(t, Generation{Catalog: 1})
	if err := router.Set(context.Background(), key, []byte("value"), time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := router.Delete(context.Background(), key); err != nil {
		t.Fatal(err)
	}
	if n, err := router.InvalidateGeneration(context.Background(), key.Generation); err != nil || n != 2 {
		t.Fatalf("generation invalidation=(%d,%v), want (2,nil)", n, err)
	}
	if n, err := router.InvalidateAccount(context.Background(), "provider", "account"); err != nil || n != 3 {
		t.Fatalf("account invalidation=(%d,%v), want (3,nil)", n, err)
	}
	if n, err := router.InvalidateAll(context.Background()); err != nil || n != 4 {
		t.Fatalf("all invalidation=(%d,%v), want (4,nil)", n, err)
	}
	if remote.generationCalls != 1 || remote.accountCalls != 1 || remote.allCalls != 1 {
		t.Fatalf("remote invalidation calls=%d,%d,%d", remote.generationCalls, remote.accountCalls, remote.allCalls)
	}
}

func TestRouterRejectsInvalidContextsAndConfiguration(t *testing.T) {
	fallback := NewMemory(MemoryConfig{})
	router, err := NewRouter(nil, fallback)
	if err != nil {
		t.Fatal(err)
	}
	defer router.Close()
	key := redisTestKey(t, Generation{Catalog: 1})
	if _, err := NewRouterWithPolicy(nil, nil, RouterPolicyAdvisory); !errors.Is(err, ErrRouterConfig) {
		t.Fatalf("nil fallback error=%v", err)
	}
	if _, err := NewRouterWithPolicy(nil, fallback, RouterPolicy("bad")); !errors.Is(err, ErrRouterConfig) {
		t.Fatalf("bad policy error=%v", err)
	}
	if _, err := router.Get(nil, key); !errors.Is(err, ErrRouterConfig) {
		t.Fatalf("nil get context=%v", err)
	}
	if err := router.Set(nil, key, []byte("x"), time.Minute); !errors.Is(err, ErrRouterConfig) {
		t.Fatalf("nil set context=%v", err)
	}
	if err := router.Delete(nil, key); !errors.Is(err, ErrRouterConfig) {
		t.Fatalf("nil delete context=%v", err)
	}
	if _, err := router.InvalidateAll(nil); !errors.Is(err, ErrRouterConfig) {
		t.Fatalf("nil invalidate context=%v", err)
	}
	if err := router.Probe(nil); !errors.Is(err, ErrRouterConfig) {
		t.Fatalf("nil probe context=%v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := router.Get(ctx, key); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled get=%v", err)
	}
}
