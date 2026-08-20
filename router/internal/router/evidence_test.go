package router

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/telemetry"
	contracts "github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/router/catalog"
)

const routerEvidenceSecret = "authorization=Bearer router-evidence-secret"

type evidenceAccountStore struct{ accounts []Account }

func (s evidenceAccountStore) ListAccounts(context.Context, string) ([]Account, error) {
	return append([]Account(nil), s.accounts...), nil
}

type evidenceTransport struct{ calls int }

func (t *evidenceTransport) Call(ctx context.Context, _ Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls++
	RecordAttemptNetwork(ctx, true, "proxy-operational-id")
	if t.calls == 1 {
		return nil, &contracts.RouteError{
			Kind: contracts.ErrorTransient, Code: "provider.transient", Message: "bounded failure",
			Retryable: true, AlternateAccountEligible: true,
			RateScope: contracts.RateScopeAccount, RatePhase: contracts.RatePhaseProvider,
			Scope: contracts.RateScopeAccount, Phase: contracts.RatePhaseProvider,
		}
	}
	return &contracts.Response{StatusCode: http.StatusOK, Headers: make(http.Header), Body: []byte(`{"usage":{"input_tokens":3,"output_tokens":5}}`)}, nil
}

func TestRouterEmitsExactlyOneRecordPerTransportCall(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: evidenceAccountStore{accounts: []Account{
		{ID: "account-a", Provider: "provider", Model: "model", Enabled: true},
		{ID: routerEvidenceSecret, Provider: "provider", Model: "model", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	sink := &telemetry.CountingSink{}
	recorder := telemetry.NewRecorder(context.Background(), sink, telemetry.WithCapacity(16))
	registry := telemetry.NewRegistry().WithRecorder(recorder)
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 2, Observer: registry})
	if err != nil {
		t.Fatal(err)
	}
	transport := &evidenceTransport{}
	req := contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{"model":"model"}`),
		Headers: http.Header{"X-Request-ID": []string{routerEvidenceSecret}},
	}
	plan := catalog.RoutePlan{
		RequestedModel: "model", Generation: 42, Strategy: catalog.RouteStrategySingle,
		Members: []catalog.RouteMember{{ProviderID: "provider", ClientModelID: "model", UpstreamModelID: "model", Surface: req.Protocol}},
	}
	response, failure, routeErr := router.Route(context.Background(), transport, req, plan)
	if routeErr != nil || failure != nil || response == nil {
		t.Fatalf("response=%#v failure=%#v err=%v", response, failure, routeErr)
	}
	if err := recorder.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if transport.calls != 2 {
		t.Fatalf("transport calls=%d want=2", transport.calls)
	}
	var attempts []telemetry.RequestEvent
	for _, event := range sink.Events() {
		if event.Stage == telemetry.StageProviderCall {
			attempts = append(attempts, event)
		}
	}
	if len(attempts) != transport.calls {
		t.Fatalf("attempt evidence=%d calls=%d events=%#v", len(attempts), transport.calls, sink.Events())
	}
	if attempts[0].AttemptResult != telemetry.AttemptFailed || attempts[1].AttemptResult != telemetry.AttemptSucceeded {
		t.Fatalf("attempt results=%q/%q", attempts[0].AttemptResult, attempts[1].AttemptResult)
	}
	if attempts[0].RetryAction != string(RetryNextAccount) || attempts[1].NetworkMode != "proxy" {
		t.Fatalf("attempt decisions=%#v", attempts)
	}
	if attempts[0].RequestID != "[redacted]" || attempts[1].RequestID != "[redacted]" {
		t.Fatalf("request IDs were not redacted: %#v", attempts)
	}
	if strings.Contains(strings.ToLower(fmt.Sprintf("%#v", attempts)), "router-evidence-secret") {
		t.Fatalf("attempt evidence leaked secret: %#v", attempts)
	}
}

func TestAttemptObserverPanicCannotChangeClientOutcome(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: evidenceAccountStore{accounts: []Account{{ID: "account", Provider: "provider", Model: "model", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 1, Observer: panickingAttemptObserver{}})
	if err != nil {
		t.Fatal(err)
	}
	response, failure, routeErr := router.Route(context.Background(), &successfulEvidenceTransport{}, contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{"model":"model"}`)}, catalog.RoutePlan{
		RequestedModel: "model", Strategy: catalog.RouteStrategySingle,
		Members: []catalog.RouteMember{{ProviderID: "provider", ClientModelID: "model", UpstreamModelID: "model", Surface: contracts.SurfaceOpenAIChat}},
	})
	if routeErr != nil || failure != nil || response == nil {
		t.Fatalf("observer panic changed outcome: response=%#v failure=%#v err=%v", response, failure, routeErr)
	}
}

type successfulEvidenceTransport struct{}

func (*successfulEvidenceTransport) Call(context.Context, Account, contracts.Request) (*contracts.Response, error) {
	return &contracts.Response{StatusCode: http.StatusOK, Headers: make(http.Header), Body: []byte(`{}`)}, nil
}

type panickingAttemptObserver struct{}

func (panickingAttemptObserver) ObserveAttempt(telemetry.AttemptEvidence) {
	panic(errors.New("observer panic"))
}
func (panickingAttemptObserver) ObserveCandidateExclusion(telemetry.CandidateExclusionEvidence) {
	panic(errors.New("observer panic"))
}
func (panickingAttemptObserver) ObserveRepair(telemetry.RepairEvidence) {
	panic(errors.New("observer panic"))
}
func (panickingAttemptObserver) ObserveStreamFinalization(telemetry.StreamFinalizationEvidence) {
	panic(errors.New("observer panic"))
}
func (panickingAttemptObserver) ObserveRequestAttempts(int) { panic(errors.New("observer panic")) }
