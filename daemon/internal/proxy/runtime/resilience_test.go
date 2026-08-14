package proxy

import (
	"context"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

type failoverStore struct{ accounts []Account }

func (s failoverStore) ListAccounts(context.Context, string) ([]Account, error) {
	return append([]Account(nil), s.accounts...), nil
}

type scriptedTransport struct{ calls int }

func (t *scriptedTransport) Call(_ context.Context, acct Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls++
	if acct.ID == "a" {
		return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, Provider: acct.Provider, Message: "fixture 503", StatusCode: 503}
	}
	return &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":true}`)}, nil
}

func TestRouterFailoverAfterTransientProviderFailure(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}, {ID: "b", Provider: "openai", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 2})
	if err != nil {
		t.Fatal(err)
	}
	transport := &scriptedTransport{}
	response, failure, err := router.Route(context.Background(), transport, contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{}`)})
	if err != nil || failure != nil || response.StatusCode != 200 || transport.calls != 2 {
		t.Fatalf("response=%#v failure=%#v err=%v calls=%d", response, failure, err, transport.calls)
	}
	state, _ := pool.Snapshot("a")
	if state != StateCoolingDown {
		t.Fatalf("state=%s", state)
	}
}

func TestRouterStopsOnAuthenticationFailureWhenNoRefresh(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	_, failure, err := router.Route(context.Background(), authTransport{}, contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model"})
	if err != nil || failure == nil || failure.Kind != FailureAuthentication {
		t.Fatalf("failure=%#v err=%v", failure, err)
	}
}

type authTransport struct{}

func (authTransport) Call(context.Context, Account, contracts.Request) (*contracts.Response, error) {
	return nil, &contracts.RouteError{Kind: contracts.ErrorAuthentication, Message: "unauthorized", StatusCode: 401}
}

type recordingFailureTransport struct {
	ids []string
}

func (t *recordingFailureTransport) Call(_ context.Context, acct Account, _ contracts.Request) (*contracts.Response, error) {
	t.ids = append(t.ids, acct.ID)
	return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, Provider: acct.Provider, StatusCode: 503}
}

func TestRouterDoesNotRepeatFailedAccount(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{
		{ID: "a", Provider: "openai", Enabled: true},
		{ID: "b", Provider: "openai", Enabled: true},
		{ID: "c", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	transport := &recordingFailureTransport{}
	_, failure, err := router.Route(context.Background(), transport, contracts.Request{Protocol: contracts.SurfaceOpenAIChat})
	if err != nil || failure == nil {
		t.Fatalf("failure=%#v err=%v", failure, err)
	}
	seen := make(map[string]bool, len(transport.ids))
	for _, id := range transport.ids {
		if seen[id] {
			t.Fatalf("account %q attempted twice: %v", id, transport.ids)
		}
		seen[id] = true
	}
}

type boundedRefreshTransport struct{ calls int }

func (t *boundedRefreshTransport) Call(_ context.Context, acct Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls++
	return nil, &contracts.RouteError{Kind: contracts.ErrorAuthentication, Provider: acct.Provider, StatusCode: 401}
}

type boundedRefresh struct{ calls int }

func (r *boundedRefresh) Refresh(context.Context, string) error {
	r.calls++
	return nil
}

func TestRouterRefreshBudgetDoesNotLoopSameAccount(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{
		{ID: "a", Provider: "openai", Enabled: true},
		{ID: "b", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	refresher := &boundedRefresh{}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 3, MaxRefreshAttempts: 1, Refresher: refresher})
	if err != nil {
		t.Fatal(err)
	}
	transport := &boundedRefreshTransport{}
	_, failure, err := router.Route(context.Background(), transport, contracts.Request{Protocol: contracts.SurfaceOpenAIChat})
	if err != nil || failure == nil {
		t.Fatalf("failure=%#v err=%v", failure, err)
	}
	if refresher.calls != 1 {
		t.Fatalf("refresh calls=%d, want one", refresher.calls)
	}
	if transport.calls != 3 {
		t.Fatalf("transport calls=%d, want bounded attempts", transport.calls)
	}
}

type cancellationTransport struct{ calls int }

func (t *cancellationTransport) Call(context.Context, Account, contracts.Request) (*contracts.Response, error) {
	t.calls++
	return nil, context.Canceled
}

func TestRouterCancellationStopsBeforeAttempt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool})
	if err != nil {
		t.Fatal(err)
	}
	transport := &cancellationTransport{}
	_, failure, err := router.Route(ctx, transport, contracts.Request{Protocol: contracts.SurfaceOpenAIChat})
	if err != nil || failure == nil || failure.Kind != FailureAborted {
		t.Fatalf("failure=%#v err=%v", failure, err)
	}
	if transport.calls != 0 {
		t.Fatalf("transport calls=%d, want zero", transport.calls)
	}
}
