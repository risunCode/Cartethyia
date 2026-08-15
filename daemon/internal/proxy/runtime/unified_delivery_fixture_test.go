package proxy

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

type unifiedRouteStore struct{ accounts []Account }

func (s unifiedRouteStore) ListAccounts(context.Context, string) ([]Account, error) {
	return append([]Account(nil), s.accounts...), nil
}

type refreshRetryTransport struct {
	calls atomic.Int32
}

func (t *refreshRetryTransport) Call(_ context.Context, _ Account, _ contracts.Request) (*contracts.Response, error) {
	if t.calls.Add(1) == 1 {
		return nil, &contracts.RouteError{
			Kind:                     contracts.ErrorAuthentication,
			StatusCode:               401,
			Code:                     "provider.authentication_failed",
			Message:                  "authentication failed",
			Retryable:                true,
			AlternateAccountEligible: true,
		}
	}
	return &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":true}`)}, nil
}

type countingRefresher struct{ calls atomic.Int32 }

func (r *countingRefresher) Refresh(context.Context, string) error {
	r.calls.Add(1)
	return nil
}

func TestRouterRefreshRetryReusesAccountBeforeFailover(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: unifiedRouteStore{accounts: []Account{{ID: "acct", Provider: "openai", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	refresher := &countingRefresher{}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 2, Refresher: refresher})
	if err != nil {
		t.Fatal(err)
	}
	transport := &refreshRetryTransport{}
	response, failure, err := router.Route(context.Background(), transport, contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat,
		Model:    "model",
		Body:     []byte(`{"messages":[]}`),
	}, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
	if err != nil || failure != nil || response == nil || response.StatusCode != 200 {
		t.Fatalf("response=%#v failure=%#v err=%v", response, failure, err)
	}
	if got := transport.calls.Load(); got != 2 {
		t.Fatalf("transport calls = %d, want refresh retry then success", got)
	}
	if got := refresher.calls.Load(); got != 1 {
		t.Fatalf("refresh calls = %d, want exactly one", got)
	}
}

func TestRouterContentPolicyDoesNotFailOverOrPoisonAccount(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: unifiedRouteStore{accounts: []Account{
		{ID: "a", Provider: "openai", Enabled: true},
		{ID: "b", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 2})
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	transport := routeTransportFunc(func(_ context.Context, acct Account, _ contracts.Request) (*contracts.Response, error) {
		calls.Add(1)
		if acct.ID == "a" {
			return nil, &contracts.RouteError{
				Kind:                     contracts.ErrorInvalidRequest,
				StatusCode:               403,
				Code:                     "provider.content_policy",
				Message:                  "request rejected by provider policy",
				AlternateAccountEligible: false,
			}
		}
		return &contracts.Response{StatusCode: 200}, nil
	})
	_, failure, err := router.Route(context.Background(), transport, contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model"}, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
	if err != nil || failure == nil || failure.CodeString() != "provider.content_policy" {
		t.Fatalf("failure=%#v err=%v", failure, err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("transport calls = %d, want no failover for policy refusal", got)
	}
	state, _ := pool.Snapshot("a")
	if state != StateHealthy {
		t.Fatalf("content-policy refusal changed account state to %s", state)
	}
}

func TestClassifierBodySignalsOverrideGenericStatusForQuotaAndCapacity(t *testing.T) {
	quota := Classify(ClassifyInput{StatusCode: 403, BodyPeek: `{"error":"insufficient_quota"}`})
	if quota.Kind != FailureQuota || !quota.AlternateAccountEligible || !quota.Poison {
		t.Fatalf("quota classification=%#v", quota)
	}
	capacity := Classify(ClassifyInput{StatusCode: 400, BodyPeek: `{"error":"model_capacity_exhausted"}`})
	if capacity.Kind != FailureCapacity || !capacity.AlternateAccountEligible || !capacity.Poison {
		t.Fatalf("capacity classification=%#v", capacity)
	}
}

func TestFailureEvidenceNeverIncludesProviderBodyOrSecrets(t *testing.T) {
	secret := "refresh-token=fixture-secret-123"
	failure := Classify(ClassifyInput{StatusCode: 403, BodyPeek: `{"error":"insufficient_quota","detail":"` + secret + `"}`})
	if strings.Contains(failure.Error(), secret) || strings.Contains(failure.Message, secret) {
		t.Fatalf("classified error leaked provider body: %q", failure.Error())
	}
	code, _, _, _, _, _, _ := failure.LifecycleEvidence()
	if code == "" || strings.Contains(code, secret) {
		t.Fatalf("unsafe lifecycle code=%q", code)
	}
}

type routeTransportFunc func(context.Context, Account, contracts.Request) (*contracts.Response, error)

func (f routeTransportFunc) Call(ctx context.Context, acct Account, req contracts.Request) (*contracts.Response, error) {
	return f(ctx, acct, req)
}
