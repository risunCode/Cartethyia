package proxy

import (
	"context"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
)

type hedgeTestTransport struct {
	calls int
}

func (t *hedgeTestTransport) Call(_ context.Context, _ Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls++
	return &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":true}`)}, nil
}

func hedgeEligiblePlan() catalog.RoutePlan {
	return catalog.RoutePlan{
		RequestedModel: "model",
		Strategy:       catalog.RouteStrategySingle,
		Members: []catalog.RouteMember{
			{ProviderID: "openai", ClientModelID: "model", UpstreamModelID: "model", Surface: contracts.SurfaceOpenAIChat},
			{ProviderID: "openai", ClientModelID: "model", UpstreamModelID: "model", Surface: contracts.SurfaceOpenAIChat},
		},
	}
}

func newHedgeRouter(t *testing.T, wait func(context.Context, time.Duration) bool) (*Router, *hedgeTestTransport) {
	t.Helper()
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{
		{ID: "a", Provider: "openai", Enabled: true},
		{ID: "b", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{
		Pool: pool, MaxAttempts: 3, HedgeEnabled: true, HedgeDelay: 10 * time.Millisecond, Wait: wait,
	})
	if err != nil {
		t.Fatal(err)
	}
	return router, &hedgeTestTransport{}
}

func TestHedgeExecutionFirstAttemptWinsBeforeDelay(t *testing.T) {
	router, transport := newHedgeRouter(t, func(_ context.Context, _ time.Duration) bool { return false })
	req := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}
	response, _, err := router.Route(context.Background(), transport, req, hedgeEligiblePlan())
	if err != nil {
		t.Fatalf("route error: %v", err)
	}
	if transport.calls != 1 {
		t.Fatalf("expected 1 transport call, got %d", transport.calls)
	}
	if response == nil || response.StatusCode != 200 {
		t.Fatalf("expected success, got %+v", response)
	}
}

func TestHedgeExecutionSecondAccountWins(t *testing.T) {
	router, transport := newHedgeRouter(t, func(_ context.Context, _ time.Duration) bool { return true })
	req := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}
	response, _, err := router.Route(context.Background(), transport, req, hedgeEligiblePlan())
	if err != nil {
		t.Fatalf("route error: %v", err)
	}
	if transport.calls < 2 {
		t.Fatalf("expected >= 2 transport calls, got %d", transport.calls)
	}
	if response == nil || response.StatusCode != 200 {
		t.Fatalf("expected success, got %+v", response)
	}
}
