package router

import (
	"context"
	"net/http"
	"strings"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/router/catalog"
)

// memberBudgetStore serves distinct accounts per provider so within-member
// retries always have a fresh candidate until the per-member budget is spent.
type memberBudgetStore struct{ accounts []Account }

func (s memberBudgetStore) ListAccounts(_ context.Context, providerID string) ([]Account, error) {
	out := make([]Account, 0, len(s.accounts))
	for _, account := range s.accounts {
		if account.Provider == providerID {
			out = append(out, account)
		}
	}
	return out, nil
}

type memberBudgetTransport struct{ calls []string }

func (t *memberBudgetTransport) Call(_ context.Context, acct Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls = append(t.calls, acct.Provider+":"+acct.ID)
	if acct.Provider == "provider-a" {
		return nil, &contracts.RouteError{
			Kind: contracts.ErrorTransient, Code: "provider-a.transient", Message: "fixture transient",
			Retryable: true, AlternateAccountEligible: true,
			Scope: contracts.RateScopeAccount, Phase: contracts.RatePhaseProvider,
		}
	}
	return &contracts.Response{StatusCode: http.StatusOK, Body: []byte(`{"ok":true}`)}, nil
}

type failingMemberTransport struct{ calls int }

func (t *failingMemberTransport) Call(_ context.Context, _ Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls++
	// Provider-scoped failures leave account cooldown state untouched, so
	// every member can still acquire the same accounts until the route-wide
	// cap — not cooldowns — ends the route.
	return nil, &contracts.RouteError{
		Kind: contracts.ErrorTransient, Code: "provider.transient", Message: "fixture transient",
		Retryable: true, AlternateAccountEligible: true,
		Scope: contracts.RateScopeProvider, RateScope: contracts.RateScopeProvider,
		Phase: contracts.RatePhaseProvider, RatePhase: contracts.RatePhaseProvider,
	}
}

func memberBudgetPlan(surface contracts.Surface) catalog.RoutePlan {
	return catalog.RoutePlan{
		RequestedModel: "budget",
		Generation:     11,
		Strategy:       catalog.RouteStrategyFallback,
		Members: []catalog.RouteMember{
			{ProviderID: "provider-a", ClientModelID: "client-a", UpstreamModelID: "upstream-a", Surface: surface},
			{ProviderID: "provider-b", ClientModelID: "client-b", UpstreamModelID: "upstream-b", Surface: surface},
		},
	}
}

func newMemberBudgetRouter(t *testing.T, config RouterConfig) *Router {
	t.Helper()
	pool, err := NewAccountPool(PoolConfig{Store: memberBudgetStore{accounts: []Account{
		{ID: "a1", Provider: "provider-a", Enabled: true},
		{ID: "a2", Provider: "provider-a", Enabled: true},
		{ID: "a3", Provider: "provider-a", Enabled: true},
		{ID: "b1", Provider: "provider-b", Enabled: true},
		{ID: "b2", Provider: "provider-b", Enabled: true},
		{ID: "b3", Provider: "provider-b", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	config.Pool = pool
	router, err := NewRouter(config)
	if err != nil {
		t.Fatal(err)
	}
	return router
}

// TestRouterMemberBudgetGivesEachMemberFullAttempts proves the per-member
// budget fix: member 1 exhausts its whole budget and member 2 still receives
// its full attempts, succeeding where the legacy shared budget stopped early.
func TestRouterMemberBudgetGivesEachMemberFullAttempts(t *testing.T) {
	router := newMemberBudgetRouter(t, RouterConfig{MaxAttemptsPerMember: 3})
	transport := &memberBudgetTransport{}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "budget", Body: []byte(`{}`)}
	response, failure, err := router.Route(context.Background(), transport, request, memberBudgetPlan(request.Protocol))
	if err != nil || failure != nil || response == nil || response.StatusCode != http.StatusOK {
		t.Fatalf("response=%#v failure=%#v err=%v", response, failure, err)
	}
	joined := strings.Join(transport.calls, ",")
	want := "provider-a:a1,provider-a:a2,provider-a:a3,provider-b:b1"
	if len(transport.calls) != 4 || joined != want {
		t.Fatalf("calls=%q, want %q", joined, want)
	}
}

// TestRouterGlobalBudgetIsSharedAcrossMembers documents the legacy semantics:
// without MaxAttemptsPerMember, one route-wide counter lets the first member
// consume every remaining attempt, leaving later members untried.
func TestRouterGlobalBudgetIsSharedAcrossMembers(t *testing.T) {
	router := newMemberBudgetRouter(t, RouterConfig{MaxAttempts: 3})
	transport := &memberBudgetTransport{}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "budget", Body: []byte(`{}`)}
	response, failure, err := router.Route(context.Background(), transport, request, memberBudgetPlan(request.Protocol))
	if err != nil || response != nil || failure == nil {
		t.Fatalf("response=%#v failure=%#v err=%v", response, failure, err)
	}
	joined := strings.Join(transport.calls, ",")
	if len(transport.calls) != 3 || joined != "provider-a:a1,provider-a:a2,provider-a:a3" {
		t.Fatalf("calls=%q, want three provider-a attempts", joined)
	}
}

// TestRouterMemberBudgetOverallCapStaysBounded proves the route-wide ceiling:
// with per-member budgeting enabled, total attempts never exceed
// MaxRouteAttempts even when the plan lists more members than the cap allows.
func TestRouterMemberBudgetOverallCapStaysBounded(t *testing.T) {
	router := newMemberBudgetRouter(t, RouterConfig{MaxAttemptsPerMember: 3})
	failing := &failingMemberTransport{}
	members := make([]catalog.RouteMember, 0, 12)
	for i := 0; i < 12; i++ {
		members = append(members, catalog.RouteMember{
			ProviderID: "provider-a", ClientModelID: "client", UpstreamModelID: "upstream", Surface: contracts.SurfaceOpenAIChat,
		})
	}
	plan := catalog.RoutePlan{RequestedModel: "cap", Strategy: catalog.RouteStrategyFallback, Members: members}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "cap", Body: []byte(`{}`)}
	response, failure, err := router.Route(context.Background(), failing, request, plan)
	if err != nil || response != nil || failure == nil {
		t.Fatalf("response=%#v failure=%#v err=%v", response, failure, err)
	}
	if failing.calls != MaxRouteAttempts {
		t.Fatalf("calls=%d, want exhaustion exactly at MaxRouteAttempts=%d", failing.calls, MaxRouteAttempts)
	}
}
