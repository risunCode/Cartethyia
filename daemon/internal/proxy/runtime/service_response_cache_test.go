package proxy

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
	"github.com/cartethyia/daemon/internal/runtime/cache"
)

var validProviderBody = []byte(`{"id":"resp_fixture","object":"response","model":"model","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}`)

type countingTransport struct{ calls int }

func (t *countingTransport) Call(_ context.Context, _ Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls++
	return &contracts.Response{StatusCode: http.StatusOK, Headers: http.Header{"Content-Type": []string{"application/json"}}, Body: append([]byte(nil), validProviderBody...)}, nil
}

func newCountingService(t *testing.T, transport *countingTransport) *DispatchService {
	t.Helper()
	pool, err := NewAccountPool(PoolConfig{Store: lifecycleStore{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 2})
	if err != nil {
		t.Fatal(err)
	}
	return &DispatchService{Router: router, Transport: transport, Codecs: transforms.NewDefaultRegistry()}
}

func countingRequest() *contracts.Request {
	return &contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{"model":"model","messages":[{"role":"user","content":"hello"}]}`), Headers: http.Header{"X-Request-ID": []string{"cache-test-1"}}}
}

func responseCacheSpecForRequest(tenant string, req *contracts.Request) cache.ResponseSpec {
	digest := sha256.Sum256(req.Body)
	return cache.ResponseSpec{TenantID: tenant, SourceSurface: string(req.Protocol), TargetSurface: string(req.Protocol), Provider: "openai", Model: req.Model, RequestBodyDigest: fmt.Sprintf("%x", digest[:]), Generation: cache.Generation{Health: 1, Network: 1}, Complete: true}
}

func TestResponseCacheHitNoProviderCall(t *testing.T) {
	transport := &countingTransport{}
	service := newCountingService(t, transport)
	responses, err := cache.NewResponseCache(cache.NewMemory(cache.MemoryConfig{MaxEntries: 4, MaxBytes: 4096}), true, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	normalized, err := service.validateRequest(context.Background(), countingRequest())
	if err != nil {
		t.Fatal(err)
	}
	spec := responseCacheSpecForRequest("tenant_1", normalized)
	if err := responses.SetValidated(context.Background(), spec, validProviderBody, func(b []byte) error {
		return validateProviderResponse(&contracts.Response{StatusCode: 200, Body: b})
	}); err != nil {
		t.Fatal(err)
	}
	service.ResponseCache = responses
	service.ResponseCacheTenant = func(_ context.Context, _ contracts.Request) string { return "tenant_1" }
	if _, err := service.DispatchContext(context.Background(), countingRequest()); err != nil {
		t.Fatal(err)
	}
	if transport.calls != 0 {
		t.Fatalf("expected 0 transport calls, got %d", transport.calls)
	}
}

func TestResponseCacheSetThenHit(t *testing.T) {
	transport := &countingTransport{}
	service := newCountingService(t, transport)
	responses, err := cache.NewResponseCache(cache.NewMemory(cache.MemoryConfig{MaxEntries: 4, MaxBytes: 4096}), true, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	service.ResponseCache = responses
	service.ResponseCacheTenant = func(_ context.Context, _ contracts.Request) string { return "tenant_1" }
	req := countingRequest()
	if _, err := service.DispatchContext(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	transport.calls = 0
	if _, err := service.DispatchContext(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if transport.calls != 0 {
		t.Fatalf("expected 0 transport calls on hit, got %d", transport.calls)
	}
}

// countingCacheBackend wraps a real backend and counts the response-cache
// boundary calls so tests can prove Get/Set are actually invoked when the
// cache is wired into the dispatch service.
type countingCacheBackend struct {
	inner cache.Cache
	gets  int
	sets  int
}

func (c *countingCacheBackend) Get(ctx context.Context, key cache.Key) (cache.Entry, error) {
	c.gets++
	return c.inner.Get(ctx, key)
}

func (c *countingCacheBackend) Set(ctx context.Context, key cache.Key, value []byte, ttl time.Duration) error {
	c.sets++
	return c.inner.Set(ctx, key, value, ttl)
}

func (c *countingCacheBackend) Delete(ctx context.Context, key cache.Key) error {
	return c.inner.Delete(ctx, key)
}
func (c *countingCacheBackend) Health(ctx context.Context) cache.Health { return c.inner.Health(ctx) }
func (c *countingCacheBackend) Close() error                            { return c.inner.Close() }

// TestResponseCacheGetSetInvokedWhenWired proves the wired cache is consulted
// (Get on every eligible dispatch) and populated (Set after a successful
// buffered provider response), and that the second dispatch is served from
// the cache without a provider call.
func TestResponseCacheGetSetInvokedWhenWired(t *testing.T) {
	transport := &countingTransport{}
	service := newCountingService(t, transport)
	backend := &countingCacheBackend{inner: cache.NewMemory(cache.MemoryConfig{MaxEntries: 4, MaxBytes: 4096})}
	t.Cleanup(func() { _ = backend.Close() })
	responses, err := cache.NewResponseCache(backend, true, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	service.ResponseCache = responses
	service.ResponseCacheTenant = func(_ context.Context, _ contracts.Request) string { return "tenant_1" }
	req := countingRequest()
	if _, err := service.DispatchContext(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if backend.gets != 1 || backend.sets != 1 {
		t.Fatalf("after first dispatch: gets=%d sets=%d, want 1/1 (miss then store)", backend.gets, backend.sets)
	}
	transport.calls = 0
	if _, err := service.DispatchContext(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if backend.gets != 2 || backend.sets != 1 {
		t.Fatalf("after second dispatch: gets=%d sets=%d, want 2/1 (hit, no re-store)", backend.gets, backend.sets)
	}
	if transport.calls != 0 {
		t.Fatalf("expected 0 transport calls on hit, got %d", transport.calls)
	}
}

// TestResponseCacheAnonymousTenantNeverTouchesBackend proves the eligibility
// rules stay strict: without a resolved tenant the wired cache is never
// consulted, so anonymous dispatches cannot read or populate entries.
func TestResponseCacheAnonymousTenantNeverTouchesBackend(t *testing.T) {
	transport := &countingTransport{}
	service := newCountingService(t, transport)
	backend := &countingCacheBackend{inner: cache.NewMemory(cache.MemoryConfig{MaxEntries: 4, MaxBytes: 4096})}
	t.Cleanup(func() { _ = backend.Close() })
	responses, err := cache.NewResponseCache(backend, true, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	service.ResponseCache = responses
	service.ResponseCacheTenant = func(_ context.Context, _ contracts.Request) string { return "" }
	if _, err := service.DispatchContext(context.Background(), countingRequest()); err != nil {
		t.Fatal(err)
	}
	if backend.gets != 0 || backend.sets != 0 {
		t.Fatalf("backend interaction without tenant: gets=%d sets=%d, want 0/0", backend.gets, backend.sets)
	}
	if transport.calls != 1 {
		t.Fatalf("transport calls=%d, want 1 (cache fully bypassed)", transport.calls)
	}
}
