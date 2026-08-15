package cache

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTask22CacheSingleFlightAndInvalidBoundaries(t *testing.T) {
	cache := NewMemory(MemoryConfig{MaxEntries: 8, MaxBytes: 4096, MaxInFlight: 2})
	defer cache.Close()
	key, err := NewKey("fixture-model", "openai-chat", []CapabilityRequirement{"text"}, Generation{Catalog: 1}, Scope{Provider: "fixture"}, NetworkPolicy{}, AffinityNone)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cache.GetOrLoad(nil, key, func(context.Context, Key) (Entry, error) { return Entry{}, nil }); err != ErrInvalidContext {
		t.Fatalf("nil context err=%v", err)
	}
	if _, err := cache.GetOrLoad(context.Background(), key, nil); err == nil {
		t.Fatal("nil loader unexpectedly succeeded")
	}
	var loaders atomic.Int32
	var leader sync.Once
	started := make(chan struct{})
	release := make(chan struct{})
	results := make([]Entry, 32)
	errs := make([]error, 32)
	ready := make(chan struct{}, len(results))
	startAll := make(chan struct{})
	var wg sync.WaitGroup
	for index := range results {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			ready <- struct{}{}
			<-startAll
			results[index], errs[index] = cache.GetOrLoad(context.Background(), key, func(_ context.Context, k Key) (Entry, error) {
				loaders.Add(1)
				leader.Do(func() { close(started) })
				<-release
				return Entry{Key: k, Value: []byte("fixture"), Generation: k.Generation, ExpiresAt: time.Now().Add(time.Minute)}, nil
			})
		}(index)
	}
	for range results {
		<-ready
	}
	close(startAll)
	<-started
	// Keep the leader in-flight long enough for every released caller to
	// register as a waiter before publishing the result. This avoids making
	// the assertion depend on scheduler timing under -race.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if got := loaders.Load(); got != 1 {
		t.Fatalf("loader calls=%d, want one", got)
	}
	for index := range results {
		if errs[index] != nil || string(results[index].Value) != "fixture" {
			t.Fatalf("result[%d]=%#v err=%v", index, results[index], errs[index])
		}
	}
}
