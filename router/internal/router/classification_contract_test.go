package router

import (
	"context"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

type classificationAccountStore struct{}

func (classificationAccountStore) ListAccounts(context.Context, string) ([]Account, error) {
	return []Account{{ID: "classified-account", Provider: "fixture", Enabled: true}}, nil
}

func TestFromContractsMapsEveryDeclaredProviderOutcome(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		kind contracts.ErrorKind
		want FailureKind
	}{
		{name: "invalid request", kind: contracts.ErrorInvalidRequest, want: FailureInvalidRequest},
		{name: "unsupported", kind: contracts.ErrorUnsupported, want: FailureUnsupported},
		{name: "translation", kind: contracts.ErrorTranslation, want: FailureTranslation},
		{name: "entitlement", kind: contracts.ErrorEntitlement, want: FailureEntitlement},
		{name: "content policy", kind: contracts.ErrorContentPolicy, want: FailureContentPolicy},
		{name: "reauthentication", kind: contracts.ErrorReauthenticationRequired, want: FailureReauthenticationRequired},
		{name: "capacity", kind: contracts.ErrorCapacity, want: FailureCapacity},
		{name: "empty output", kind: contracts.ErrorEmptyOutput, want: FailureEmptyOutput},
		{name: "authentication", kind: contracts.ErrorAuthentication, want: FailureAuthentication},
		{name: "rate limit", kind: contracts.ErrorRateLimit, want: FailureRateLimit},
		{name: "quota", kind: contracts.ErrorQuota, want: FailureQuota},
		{name: "transient", kind: contracts.ErrorTransient, want: FailureTransient},
		{name: "server error", kind: contracts.ErrorServerError, want: FailureServerError},
		{name: "fatal", kind: contracts.ErrorFatal, want: FailureFatal},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := FromContracts(&contracts.RouteError{
				Kind: tc.kind, StatusCode: 503, Code: "provider.fixture", Message: "bounded failure",
				Retryable: true, RetryAfterMS: 1250, AlternateAccountEligible: true,
				RateScope: contracts.RateScopeModel, RatePhase: contracts.RatePhaseProvider,
				Scope: contracts.RateScopeModel, Phase: contracts.RatePhaseProvider,
			})
			if got.Kind != tc.want || !got.Retryable || !got.AlternateAccountEligible || got.RetryAfterMS != 1250 || got.Code != "provider.fixture" || got.Message != "bounded failure" || got.Scope != contracts.RateScopeModel || got.Phase != contracts.RatePhaseProvider {
				t.Fatalf("failure = %#v", got)
			}
		})
	}
}

func TestFromContractsPreservesExplicitNonRetryableDecision(t *testing.T) {
	t.Parallel()
	got := FromContracts(&contracts.RouteError{
		Kind: contracts.ErrorRateLimit, StatusCode: 429,
		Code: "provider.rate_limit", Message: "provider rate limited",
		Retryable: false, AlternateAccountEligible: false,
		Scope: contracts.RateScopeAccount, Phase: contracts.RatePhaseProvider,
	})
	if got.Retryable || got.AlternateAccountEligible || got.Policy != RetryNever {
		t.Fatalf("explicit stop was inferred retryable: %#v", got)
	}
}

func TestApplyFailureUpdatesOnlyClassifiedScope(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name          string
		kind          FailureKind
		scope         contracts.RateScope
		wantState     AccountState
		wantModelLock bool
	}{
		{name: "route does not touch account", kind: FailureContentPolicy, scope: contracts.RateScopeRoute, wantState: StateHealthy},
		{name: "provider does not touch account", kind: FailureServerError, scope: contracts.RateScopeProvider, wantState: StateHealthy},
		{name: "proxy does not touch account", kind: FailureTransient, scope: contracts.RateScopeProxy, wantState: StateHealthy},
		{name: "account quota exhausts account", kind: FailureQuota, scope: contracts.RateScopeAccount, wantState: StateExhausted},
		{name: "model capacity locks only model", kind: FailureCapacity, scope: contracts.RateScopeModel, wantState: StateHealthy, wantModelLock: true},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			pool, err := NewAccountPool(PoolConfig{Store: classificationAccountStore{}})
			if err != nil {
				t.Fatal(err)
			}
			lease, _, err := pool.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "fixture", ModelID: "fixture-model"})
			if err != nil {
				t.Fatal(err)
			}
			lease.Release()
			router := &Router{pool: pool}
			account := &Account{ID: "classified-account", Provider: "fixture", Enabled: true}
			router.applyFailureForModel(&Failure{Kind: tc.kind, Scope: tc.scope}, account, "fixture-model")
			state, _ := pool.Snapshot(account.ID)
			if state != tc.wantState {
				t.Fatalf("account state = %q, want %q", state, tc.wantState)
			}
			pool.mu.Lock()
			lock := pool.modelLocks[account.ID]["fixture-model"]
			pool.mu.Unlock()
			if got := !lock.RetryAt.IsZero(); got != tc.wantModelLock {
				t.Fatalf("model lock = %v, want %v", got, tc.wantModelLock)
			}
		})
	}
}
