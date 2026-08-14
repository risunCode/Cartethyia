package cache

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeRemote struct {
	mu         sync.Mutex
	values     map[string][]byte
	block      bool
	pingErr    error
	commandErr error
	closed     bool
}

func newFakeRemote() *fakeRemote { return &fakeRemote{values: make(map[string][]byte)} }

func (f *fakeRemote) wait(ctx context.Context) error {
	f.mu.Lock()
	block, commandErr, closed := f.block, f.commandErr, f.closed
	f.mu.Unlock()
	if closed {
		return ErrClosed
	}
	if block {
		<-ctx.Done()
		return ctx.Err()
	}
	return commandErr
}

func (f *fakeRemote) Get(ctx context.Context, key string) ([]byte, error) {
	if err := f.wait(ctx); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	value, ok := f.values[key]
	if !ok {
		return nil, ErrRemoteMiss
	}
	return append([]byte(nil), value...), nil
}

func (f *fakeRemote) Set(ctx context.Context, key string, value []byte, _ time.Duration) error {
	if err := f.wait(ctx); err != nil {
		return err
	}
	f.mu.Lock()
	f.values[key] = append([]byte(nil), value...)
	f.mu.Unlock()
	return nil
}

func (f *fakeRemote) Delete(ctx context.Context, key string) error {
	if err := f.wait(ctx); err != nil {
		return err
	}
	f.mu.Lock()
	delete(f.values, key)
	f.mu.Unlock()
	return nil
}

func (f *fakeRemote) Ping(ctx context.Context) error {
	if err := f.wait(ctx); err != nil {
		return err
	}
	f.mu.Lock()
	err := f.pingErr
	f.mu.Unlock()
	return err
}

func (f *fakeRemote) Close() error {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	return nil
}

func redisTestKey(t *testing.T, generation Generation) Key {
	t.Helper()
	key, err := NewKey("model", "surface", nil, generation, Scope{Provider: "provider"}, NetworkPolicy{}, AffinityNone)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func TestRedisBackendSerializationAndGeneration(t *testing.T) {
	remote := newFakeRemote()
	backend, err := NewRedisBackend(remote, RedisConfig{Prefix: "test:"})
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	key := redisTestKey(t, Generation{Catalog: 1})
	if err := backend.Set(context.Background(), key, []byte("payload"), time.Minute); err != nil {
		t.Fatal(err)
	}
	entry, err := backend.Get(context.Background(), key)
	if err != nil || string(entry.Value) != "payload" {
		t.Fatalf("get = %#v, %v", entry, err)
	}
	entry.Value[0] = 'X'
	entry, err = backend.Get(context.Background(), key)
	if err != nil || string(entry.Value) != "payload" {
		t.Fatalf("defensive get = %#v, %v", entry, err)
	}
	mismatch := redisTestKey(t, Generation{Catalog: 2})
	if _, err := backend.Get(context.Background(), mismatch); !errors.Is(err, ErrGenerationMismatch) {
		t.Fatalf("generation mismatch = %v", err)
	}
}

func TestRedisBackendRejectsMalformedSerialization(t *testing.T) {
	remote := newFakeRemote()
	backend, err := NewRedisBackend(remote, RedisConfig{})
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	key := redisTestKey(t, Generation{Catalog: 1})
	remote.mu.Lock()
	remote.values[backend.wireKey(key)] = []byte("not-json")
	remote.mu.Unlock()
	if _, err := backend.Get(context.Background(), key); !errors.Is(err, ErrRemoteSerialization) {
		t.Fatalf("malformed record error = %v", err)
	}
	if got := backend.Health(context.Background()).State; got != HealthUnhealthy {
		t.Fatalf("malformed record health = %s", got)
	}
}

func TestRouterOfflineUsesFallback(t *testing.T) {
	fallback := NewMemory(MemoryConfig{})
	defer fallback.Close()
	router, err := NewRouter(nil, fallback)
	if err != nil {
		t.Fatal(err)
	}
	key := redisTestKey(t, Generation{Catalog: 1})
	if err := router.Set(context.Background(), key, []byte("local"), time.Minute); err != nil {
		t.Fatal(err)
	}
	entry, err := router.Get(context.Background(), key)
	if err != nil || string(entry.Value) != "local" {
		t.Fatalf("offline get = %#v, %v", entry, err)
	}
	if got := router.Health(context.Background()).State; got != HealthOffline {
		t.Fatalf("offline health = %s", got)
	}
}

func TestRouterUnhealthyRecovery(t *testing.T) {
	remote := newFakeRemote()
	backend, err := NewRedisBackend(remote, RedisConfig{})
	if err != nil {
		t.Fatal(err)
	}
	fallback := NewMemory(MemoryConfig{})
	router, err := NewRouter(backend, fallback)
	if err != nil {
		t.Fatal(err)
	}
	defer router.Close()
	if got := router.Health(context.Background()).State; got != HealthUnhealthy {
		t.Fatalf("startup health = %s", got)
	}
	if err := router.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := router.Health(context.Background()).State; got != HealthOnline {
		t.Fatalf("recovered health = %s", got)
	}
	key := redisTestKey(t, Generation{Catalog: 1})
	if err := router.Set(context.Background(), key, []byte("remote"), time.Minute); err != nil {
		t.Fatal(err)
	}
	entry, err := router.Get(context.Background(), key)
	if err != nil || string(entry.Value) != "remote" {
		t.Fatalf("recovered get = %#v, %v", entry, err)
	}
}

func TestRouterCommandTimeoutFallsBackAndMarksUnhealthy(t *testing.T) {
	remote := newFakeRemote()
	backend, err := NewRedisBackend(remote, RedisConfig{CommandTimeout: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	fallback := NewMemory(MemoryConfig{})
	router, err := NewRouter(backend, fallback)
	if err != nil {
		t.Fatal(err)
	}
	defer router.Close()
	if err := router.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	remote.mu.Lock()
	remote.block = true
	remote.mu.Unlock()
	key := redisTestKey(t, Generation{Catalog: 1})
	if err := router.Set(context.Background(), key, []byte("fallback"), time.Minute); err != nil {
		t.Fatal(err)
	}
	if got := router.Health(context.Background()).State; got != HealthUnhealthy {
		t.Fatalf("timeout health = %s", got)
	}
	entry, err := fallback.Get(context.Background(), key)
	if err != nil || string(entry.Value) != "fallback" {
		t.Fatalf("fallback value = %#v, %v", entry, err)
	}
}

func TestRouterFailClosedDoesNotEquateMemoryWithRemote(t *testing.T) {
	remote := newFakeRemote()
	backend, err := NewRedisBackend(remote, RedisConfig{})
	if err != nil {
		t.Fatal(err)
	}
	fallback := NewMemory(MemoryConfig{})
	router, err := NewRouterWithPolicy(backend, fallback, RouterPolicyFailClosed)
	if err != nil {
		t.Fatal(err)
	}
	defer router.Close()
	key := redisTestKey(t, Generation{Catalog: 1})
	if err := router.Set(context.Background(), key, []byte("must-not-write"), time.Minute); !errors.Is(err, ErrCoordinationUnavailable) {
		t.Fatalf("fail-closed set = %v", err)
	}
	if _, err := fallback.Get(context.Background(), key); !errors.Is(err, ErrMiss) {
		t.Fatalf("fallback falsely populated: %v", err)
	}
}
