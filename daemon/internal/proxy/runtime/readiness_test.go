package proxy

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

type readinessStore struct{ accounts []Account }

func (s readinessStore) ListAccounts(context.Context, string) ([]Account, error) {
	return append([]Account(nil), s.accounts...), nil
}

type readinessRefresher struct{}

func (readinessRefresher) Current(context.Context, string) (*accounts.TokenSet, error) {
	return nil, nil
}

func TestAcquireCandidatePrefersReadyTier(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: readinessStore{accounts: []Account{
		{ID: "unknown", Provider: "openai", Model: "model", Enabled: true},
		{ID: "ready", Provider: "openai", Model: "model", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	pool.MarkReadiness(ReadinessRecord{AccountID: "ready", ProviderID: "openai", ModelID: "model", Surface: contracts.SurfaceOpenAIChat, Tier: ReadinessReady, CheckedAt: time.Now()})
	lease, _, err := pool.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model", Surface: contracts.SurfaceOpenAIChat})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if lease.Account.ID != "ready" {
		t.Fatalf("selected account = %q, want ready", lease.Account.ID)
	}
}

func TestProactiveRefreshPublishesBoundedReadiness(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: readinessStore{accounts: []Account{{ID: "a", Provider: "openai", Model: "model", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := pool.StartProactiveRefresh(context.Background(), readinessRefresher{}, "openai", 1, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Stop()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, record := range pool.ReadinessSnapshot() {
			if record.AccountID == "a" && record.Tier == ReadinessReady {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("proactive refresh did not publish readiness")
}

type failingCandidatePreparer struct{}

func (failingCandidatePreparer) Prepare(_ context.Context, account Account, request contracts.Request) (*PreparedAttempt, error) {
	if account.ID == "a" {
		return nil, errors.New("local credential unavailable")
	}
	return NewPreparedAttempt(account, request, nil)
}

func TestCandidatePreparationFailureDoesNotSpendAttempt(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: readinessStore{accounts: []Account{
		{ID: "a", Provider: "openai", Model: "model", Enabled: true},
		{ID: "b", Provider: "openai", Model: "model", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 1, Preparer: failingCandidatePreparer{}})
	if err != nil {
		t.Fatal(err)
	}
	transport := &lifecycleTransport{response: &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":true}`)}}
	response, failure, err := router.Route(context.Background(), transport, contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model"}, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
	if err != nil || failure != nil || response == nil {
		t.Fatalf("response=%#v failure=%#v err=%v", response, failure, err)
	}
	if transport.calls != 1 {
		t.Fatalf("provider calls = %d, want one prepared candidate", transport.calls)
	}
}
