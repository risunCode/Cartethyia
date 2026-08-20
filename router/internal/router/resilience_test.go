package router

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	contracts "github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/router/catalog"
)

func fixtureRoutePlan(providerID, modelID string, surface contracts.Surface) catalog.RoutePlan {
	return catalog.RoutePlan{RequestedModel: modelID, Strategy: catalog.RouteStrategySingle, Members: []catalog.RouteMember{{ProviderID: providerID, ClientModelID: modelID, UpstreamModelID: modelID, Surface: surface}}}
}

type failoverStore struct{ accounts []Account }

func (s failoverStore) ListAccounts(context.Context, string) ([]Account, error) {
	return append([]Account(nil), s.accounts...), nil
}

type scriptedTransport struct {
	calls int
	ids   []string
}

func (t *scriptedTransport) Call(_ context.Context, acct Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls++
	t.ids = append(t.ids, acct.ID)
	if acct.ID == "a" {
		return nil, &contracts.RouteError{
			Kind:                     contracts.ErrorTransient,
			Provider:                 acct.Provider,
			Message:                  "fixture 503",
			StatusCode:               503,
			Retryable:                true,
			AlternateAccountEligible: true,
			RateScope:                contracts.RateScopeAccount,
			Scope:                    contracts.RateScopeAccount,
			RatePhase:                contracts.RatePhaseProvider,
			Phase:                    contracts.RatePhaseProvider,
		}
	}
	return &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":true}`)}, nil
}

func TestRouterFailoverAfterTransientProviderFailure(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}, {ID: "b", Provider: "openai", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	waitCalls := 0
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 2, Wait: func(context.Context, time.Duration) bool {
		waitCalls++
		return true
	}})
	if err != nil {
		t.Fatal(err)
	}
	transport := &scriptedTransport{}
	response, failure, err := router.Route(context.Background(), transport, contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{}`)}, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
	if err != nil || failure != nil || response.StatusCode != 200 || transport.calls != 2 {
		t.Fatalf("response=%#v failure=%#v err=%v calls=%d", response, failure, err, transport.calls)
	}
	if len(transport.ids) != 2 || transport.ids[0] != "a" || transport.ids[1] != "b" {
		t.Fatalf("candidate order=%v, want [a b]", transport.ids)
	}
	if waitCalls != 0 {
		t.Fatalf("wait calls=%d with a ready alternate, want 0", waitCalls)
	}
	if inA, inB := pool.InFlight("a"), pool.InFlight("b"); inA != 0 || inB != 0 {
		t.Fatalf("in-flight after failover: a=%d b=%d, want zero", inA, inB)
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
	_, failure, err := router.Route(context.Background(), authTransport{}, contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model"}, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
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
	retryAfterMS := int64(len(t.ids) * 1000)
	return nil, &contracts.RouteError{
		Kind:                     contracts.ErrorTransient,
		Provider:                 acct.Provider,
		StatusCode:               503,
		Code:                     "provider.fixture_transient",
		Message:                  "bounded transient failure",
		Retryable:                true,
		RetryAfterMS:             retryAfterMS,
		AlternateAccountEligible: true,
		RateScope:                contracts.RateScopeAccount,
		Scope:                    contracts.RateScopeAccount,
		RatePhase:                contracts.RatePhaseProvider,
		Phase:                    contracts.RatePhaseProvider,
	}
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
	_, failure, err := router.Route(context.Background(), transport, contracts.Request{Protocol: contracts.SurfaceOpenAIChat}, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
	if err != nil || failure == nil {
		t.Fatalf("failure=%#v err=%v", failure, err)
	}
	if len(transport.ids) != 3 {
		t.Fatalf("upstream calls=%d candidate order=%v, want exactly 3 attempts", len(transport.ids), transport.ids)
	}
	if failure.CodeString() != "provider.fixture_transient" || failure.RetryAfterMS != 3000 {
		t.Fatalf("final failure code=%q retryAfterMS=%d, want last attempt evidence", failure.CodeString(), failure.RetryAfterMS)
	}
	seen := make(map[string]bool, len(transport.ids))
	for _, id := range transport.ids {
		if seen[id] {
			t.Fatalf("account %q attempted twice: %v", id, transport.ids)
		}
		seen[id] = true
	}
	for _, id := range []string{"a", "b", "c"} {
		if got := pool.InFlight(id); got != 0 {
			t.Fatalf("account %s in-flight=%d after exhaustion, want 0", id, got)
		}
	}
}

type boundedRefreshTransport struct{ calls int }

func (t *boundedRefreshTransport) Call(_ context.Context, acct Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls++
	return nil, &contracts.RouteError{
		Kind:                     contracts.ErrorAuthentication,
		Provider:                 acct.Provider,
		StatusCode:               401,
		Retryable:                true,
		AlternateAccountEligible: true,
		RateScope:                contracts.RateScopeAccount,
		Scope:                    contracts.RateScopeAccount,
		RatePhase:                contracts.RatePhaseProvider,
		Phase:                    contracts.RatePhaseProvider,
	}
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
	_, failure, err := router.Route(context.Background(), transport, contracts.Request{Protocol: contracts.SurfaceOpenAIChat}, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
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
	_, failure, err := router.Route(ctx, transport, contracts.Request{Protocol: contracts.SurfaceOpenAIChat}, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
	if err != nil || failure == nil || failure.Kind != FailureAborted {
		t.Fatalf("failure=%#v err=%v", failure, err)
	}
	if transport.calls != 0 {
		t.Fatalf("transport calls=%d, want zero", transport.calls)
	}
}

type successfulRecordingTransport struct {
	calls int
	ids   []string
}

func (t *successfulRecordingTransport) Call(_ context.Context, account Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls++
	t.ids = append(t.ids, account.ID)
	return &contracts.Response{StatusCode: http.StatusOK, Body: []byte(`{"ok":true}`)}, nil
}

func TestRouterWaitUsesInjectedClockAndStartsOneVisibleAttempt(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	pool, err := NewAccountPool(PoolConfig{
		Store: failoverStore{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}},
		Now:   func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Refresh(context.Background(), "openai"); err != nil {
		t.Fatalf("prime account pool: %v", err)
	}
	pool.MarkTransient("a")
	waits := make([]time.Duration, 0, 1)
	router, err := NewRouter(RouterConfig{
		Pool:         pool,
		MaxAttempts:  1,
		Now:          func() time.Time { return now },
		RetryWaitMax: time.Minute,
		Wait: func(_ context.Context, duration time.Duration) bool {
			waits = append(waits, duration)
			now = now.Add(duration + time.Nanosecond)
			return true
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	transport := &successfulRecordingTransport{}
	response, failure, routeErr := router.Route(context.Background(), transport, contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat,
		Model:    "model",
	}, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
	if routeErr != nil || failure != nil || response == nil || response.StatusCode != http.StatusOK {
		t.Fatalf("response=%#v failure=%#v err=%v", response, failure, routeErr)
	}
	if len(waits) != 1 || waits[0] <= 0 {
		t.Fatalf("waits=%v, want one positive fake-clock wait", waits)
	}
	if transport.calls != 1 || len(transport.ids) != 1 || transport.ids[0] != "a" {
		t.Fatalf("calls=%d candidate order=%v, want one call to a", transport.calls, transport.ids)
	}
	if got := pool.InFlight("a"); got != 0 {
		t.Fatalf("account in-flight=%d after success, want 0", got)
	}
}

func TestRouterCancellationDuringInjectedWaitStartsNoAttempt(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	pool, err := NewAccountPool(PoolConfig{
		Store: failoverStore{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}},
		Now:   func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Refresh(context.Background(), "openai"); err != nil {
		t.Fatalf("prime account pool: %v", err)
	}
	pool.MarkTransient("a")
	ctx, cancel := context.WithCancel(context.Background())
	waitCalls := 0
	router, err := NewRouter(RouterConfig{
		Pool:         pool,
		MaxAttempts:  2,
		Now:          func() time.Time { return now },
		RetryWaitMax: time.Minute,
		Wait: func(_ context.Context, duration time.Duration) bool {
			waitCalls++
			if duration <= 0 {
				t.Fatalf("wait duration=%s, want positive", duration)
			}
			cancel()
			return false
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	transport := &successfulRecordingTransport{}
	response, failure, routeErr := router.Route(ctx, transport, contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat,
		Model:    "model",
	}, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
	if routeErr != nil || response != nil || failure == nil || failure.Kind != FailureAborted {
		t.Fatalf("response=%#v failure=%#v err=%v", response, failure, routeErr)
	}
	if waitCalls != 1 {
		t.Fatalf("wait calls=%d, want 1", waitCalls)
	}
	if transport.calls != 0 {
		t.Fatalf("upstream calls after canceled wait=%d, want 0", transport.calls)
	}
	if got := pool.InFlight("a"); got != 0 {
		t.Fatalf("account in-flight=%d after canceled wait, want 0", got)
	}
}

type routePlanStore struct{ accounts []Account }

func (s routePlanStore) ListAccounts(_ context.Context, providerID string) ([]Account, error) {
	out := make([]Account, 0, len(s.accounts))
	for _, account := range s.accounts {
		if account.Provider == providerID {
			out = append(out, account)
		}
	}
	return out, nil
}

type crossProviderTransport struct {
	calls []string
	call  func(Account, contracts.Request) (*contracts.Response, error)
}

func (t *crossProviderTransport) Call(_ context.Context, account Account, req contracts.Request) (*contracts.Response, error) {
	t.calls = append(t.calls, account.Provider+":"+req.Model)
	return t.call(account, req)
}

func fallbackPlan(surface contracts.Surface) catalog.RoutePlan {
	return catalog.RoutePlan{
		RequestedModel: "fallback",
		Generation:     9,
		Strategy:       catalog.RouteStrategyFallback,
		Members: []catalog.RouteMember{
			{ProviderID: "provider-a", ClientModelID: "client-a", UpstreamModelID: "upstream-a", Surface: surface},
			{ProviderID: "provider-b", ClientModelID: "client-b", UpstreamModelID: "upstream-b", Surface: surface},
		},
	}
}

func newFallbackRouter(t *testing.T, attempts int) *Router {
	t.Helper()
	pool, err := NewAccountPool(PoolConfig{Store: routePlanStore{accounts: []Account{
		{ID: "account-a", Provider: "provider-a", Enabled: true},
		{ID: "account-b", Provider: "provider-b", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: attempts})
	if err != nil {
		t.Fatal(err)
	}
	return router
}

func TestRouterFallbackAdvancesAcrossProvidersWithinGlobalBudget(t *testing.T) {
	router := newFallbackRouter(t, 2)
	transport := &crossProviderTransport{call: func(account Account, _ contracts.Request) (*contracts.Response, error) {
		if account.Provider == "provider-a" {
			return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, Code: "provider-a.unavailable", Message: "provider unavailable", Retryable: true, AlternateAccountEligible: true, Scope: contracts.RateScopeProvider, Phase: contracts.RatePhaseProvider}
		}
		return &contracts.Response{StatusCode: http.StatusOK, Body: []byte(`{"ok":true}`)}, nil
	}}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fallback", Headers: http.Header{"X-Cartethyia-Provider": {"attacker-selected"}}}
	response, failure, err := router.Route(context.Background(), transport, request, fallbackPlan(request.Protocol))
	if err != nil || failure != nil || response == nil || response.StatusCode != http.StatusOK {
		t.Fatalf("response=%#v failure=%#v err=%v", response, failure, err)
	}
	if got, want := strings.Join(transport.calls, ","), "provider-a:client-a,provider-b:client-b"; got != want {
		t.Fatalf("calls=%q, want %q", got, want)
	}
}

func TestRouterFallbackExplicitStopDoesNotCallLaterProvider(t *testing.T) {
	router := newFallbackRouter(t, 2)
	transport := &crossProviderTransport{call: func(Account, contracts.Request) (*contracts.Response, error) {
		return nil, &contracts.RouteError{Kind: contracts.ErrorContentPolicy, Code: "provider.policy", Message: "request rejected", Retryable: false, AlternateAccountEligible: false}
	}}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fallback"}
	_, failure, err := router.Route(context.Background(), transport, request, fallbackPlan(request.Protocol))
	if err != nil || failure == nil || failure.Code != "provider.policy" {
		t.Fatalf("failure=%#v err=%v", failure, err)
	}
	if len(transport.calls) != 1 || transport.calls[0] != "provider-a:client-a" {
		t.Fatalf("calls=%v, want only first provider", transport.calls)
	}
}

func TestRouterFallbackRejectsSurfaceMismatchBeforeAttempt(t *testing.T) {
	router := newFallbackRouter(t, 2)
	transport := &crossProviderTransport{call: func(Account, contracts.Request) (*contracts.Response, error) {
		return &contracts.Response{StatusCode: http.StatusOK}, nil
	}}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fallback"}
	plan := fallbackPlan(contracts.SurfaceAnthropic)
	_, _, err := router.Route(context.Background(), transport, request, plan)
	if err == nil || len(transport.calls) != 0 {
		t.Fatalf("error=%v calls=%v", err, transport.calls)
	}
}

func TestRouterFallbackExhaustionPreservesActionableFailureAndEarliestHint(t *testing.T) {
	router := newFallbackRouter(t, 2)
	transport := &crossProviderTransport{call: func(account Account, _ contracts.Request) (*contracts.Response, error) {
		if account.Provider == "provider-a" {
			return nil, &contracts.RouteError{Kind: contracts.ErrorQuota, Code: "provider.quota", Message: "quota exhausted", Retryable: true, AlternateAccountEligible: true, RetryAfterMS: 5000, Scope: contracts.RateScopeAccount, Phase: contracts.RatePhaseProvider}
		}
		return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, Code: "provider.transient", Message: "temporary", Retryable: true, AlternateAccountEligible: true, RetryAfterMS: 1000, Scope: contracts.RateScopeProvider, Phase: contracts.RatePhaseProvider}
	}}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fallback"}
	_, failure, err := router.Route(context.Background(), transport, request, fallbackPlan(request.Protocol))
	if err != nil || failure == nil || failure.Kind != FailureQuota || failure.Code != "provider.quota" || failure.RetryAfterMS != 1000 {
		t.Fatalf("failure=%#v err=%v", failure, err)
	}
	if len(transport.calls) != 2 {
		t.Fatalf("calls=%v, want exactly two global attempts", transport.calls)
	}
}
