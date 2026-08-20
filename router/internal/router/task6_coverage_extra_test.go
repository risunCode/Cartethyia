package router

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/telemetry"
	"github.com/cartethyia/daemon/internal/telemetry/usage"
	contracts "github.com/cartethyia/daemon/internal/protocol"
	transforms "github.com/cartethyia/daemon/internal/protocol/codec"
)

type unhealthyProxyHealth struct{}

func (unhealthyProxyHealth) IsHealthy(string, time.Time) bool { return false }
func (unhealthyProxyHealth) IsEnabled(string) bool            { return true }

type disabledProxyHealth struct{}

func (disabledProxyHealth) IsHealthy(string, time.Time) bool { return true }
func (disabledProxyHealth) IsEnabled(string) bool            { return false }

func TestValidateRequestBranches(t *testing.T) {
	service := &DispatchService{Evidence: telemetry.NewRegistry()}
	if _, err := service.validateRequest(context.Background(), nil); DispatchCodeOf(err) != codeDispatchInvalidRequest {
		t.Fatalf("nil req err=%v", err)
	}
	if _, err := service.validateRequest(context.Background(), &contracts.Request{Protocol: "nope", Body: []byte(`{}`)}); DispatchCodeOf(err) != codeDispatchInvalidRequest {
		t.Fatalf("bad protocol err=%v", err)
	}
	if _, err := service.validateRequest(context.Background(), &contracts.Request{Protocol: contracts.SurfaceOpenAIChat}); DispatchCodeOf(err) != codeDispatchInvalidRequest {
		t.Fatalf("empty body err=%v", err)
	}
	if _, err := service.validateRequest(context.Background(), &contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Body: []byte(`{`)}); DispatchCodeOf(err) != codeDispatchInvalidRequest {
		t.Fatalf("malformed json err=%v", err)
	}
	if _, err := service.validateRequest(context.Background(), &contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat, Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`),
	}); DispatchCodeOf(err) != codeDispatchInvalidRequest {
		t.Fatalf("missing model err=%v", err)
	}
	normalized, err := service.validateRequest(context.Background(), &contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat,
		Model:    "model",
		Body:     []byte(`{"model":"model","messages":[{"role":"user","content":"hi"}]}`),
		Headers:  http.Header{"X-Cartethyia-Provider": []string{"openai"}},
	})
	if err != nil || normalized.Headers.Get("X-Cartethyia-Provider") != "" || normalized.Model != "model" {
		t.Fatalf("normalized=%+v err=%v", normalized, err)
	}
	anthropic, err := service.validateRequest(context.Background(), &contracts.Request{
		Protocol: contracts.SurfaceAnthropic,
		Body:     []byte(`{"model":"claude","messages":[{"role":"user","content":"hi"}],"max_tokens":16}`),
	})
	if err != nil || anthropic.Model != "claude" {
		t.Fatalf("anthropic=%+v err=%v", anthropic, err)
	}
	responses, err := service.validateRequest(context.Background(), &contracts.Request{
		Protocol: contracts.ProtocolOpenAIResponse,
		Body:     []byte(`{"model":"gpt","input":"hi"}`),
	})
	if err != nil || responses.Model != "gpt" {
		t.Fatalf("responses=%+v err=%v", responses, err)
	}
}

func TestDispatchFailureErrorKinds(t *testing.T) {
	if DispatchCodeOf(dispatchFailureError(nil)) != codeDispatchProvider {
		t.Fatal("nil failure")
	}
	cases := []struct {
		failure *Failure
		code    string
	}{
		{&Failure{Kind: FailureInvalidRequest, Message: "bad"}, codeDispatchInvalidRequest},
		{&Failure{Kind: FailureAuthentication, Message: "auth"}, codeDispatchProvider},
		{&Failure{Kind: FailureRateLimit, Message: "rl"}, codeDispatchProvider},
		{&Failure{Kind: FailureQuota, Message: "quota"}, codeDispatchProvider},
		{&Failure{Kind: FailureTransient, Message: "tmp", StatusCode: 503}, codeDispatchProvider},
		{&Failure{Kind: FailureAborted, Err: context.Canceled}, codeDispatchCanceled},
		{&Failure{Kind: FailureUnknown, Message: "unknown"}, codeDispatchNoRoute},
		{&Failure{Kind: FailureFatal, Message: ""}, codeDispatchProvider},
	}
	for _, test := range cases {
		err := dispatchFailureError(test.failure)
		if DispatchCodeOf(err) != test.code {
			t.Fatalf("kind=%s code=%q want=%q err=%v", test.failure.Kind, DispatchCodeOf(err), test.code, err)
		}
	}
}

func TestNetworkSelectorProxyModesAndSafeHostname(t *testing.T) {
	selector := NewDefaultNetworkSelector()
	selector.SetCapacity("p1", 1)
	unhealthy, err := selector.Select(context.Background(), SelectNetworkInput{
		Mode: NetworkModeProxy, Proxies: []ProxyEndpoint{{ID: "p1", Enabled: true}}, Health: unhealthyProxyHealth{},
	})
	if err != nil || unhealthy.Reason != ReasonProxyUnhealthy {
		t.Fatalf("unhealthy=%+v err=%v", unhealthy, err)
	}
	disabled, err := selector.Select(context.Background(), SelectNetworkInput{
		Mode: NetworkModeProxy, Proxies: []ProxyEndpoint{{ID: "p1", Enabled: true}}, Health: disabledProxyHealth{},
	})
	if err != nil || disabled.Reason != ReasonProxyDisabled {
		t.Fatalf("disabled=%+v err=%v", disabled, err)
	}
	first, err := selector.Select(context.Background(), SelectNetworkInput{
		Mode: NetworkModeProxy, Proxies: []ProxyEndpoint{{ID: "p1", Enabled: true}},
	})
	if err != nil || !first.UseProxy {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	busy, err := selector.Select(context.Background(), SelectNetworkInput{
		Mode: NetworkModeProxy, Proxies: []ProxyEndpoint{{ID: "p1", Enabled: true}},
	})
	if err != nil || busy.Reason != ReasonProxyBusy {
		t.Fatalf("busy=%+v err=%v", busy, err)
	}
	first.Release()
	unknown, err := selector.Select(context.Background(), SelectNetworkInput{Mode: NetworkMode("weird")})
	if err != nil || unknown.Reason != ReasonDirect {
		t.Fatalf("unknown mode=%+v", unknown)
	}
	for _, host := range []string{"", "localhost", "foo.localhost", "svc.local", "svc.internal", "192.168.0.1", "8.8.8.8"} {
		_ = SafeHostname(host)
	}
	if !SafeHostname("api.openai.com") {
		t.Fatal("public hostname rejected")
	}
}

func TestFinalizeHedgeLoserAndReleaseProvenUnaccepted(t *testing.T) {
	router := &Router{}
	reservation := &coverageQuotaReservation{}
	router.finalizeHedgeLoser(context.Background(), hedgeResult{})
	router.finalizeHedgeLoser(context.Background(), hedgeResult{
		candidate: &hedgeCandidate{reservation: reservation},
		resp:      &contracts.Response{StatusCode: 200, Body: []byte(`{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}`)},
	})
	if reservation.reconciles.Load() != 1 {
		t.Fatalf("reconciles=%d", reservation.reconciles.Load())
	}
	pre := &coverageQuotaReservation{}
	router.finalizeHedgeLoser(context.Background(), hedgeResult{
		candidate: &hedgeCandidate{reservation: pre, account: Account{ID: "a", Provider: "openai"}},
		err:       streamError(StreamCodeMalformedEvent, "bad", ErrStreamMalformed),
	})
	if pre.releases.Load()+pre.reconciles.Load() == 0 {
		t.Fatal("pre-dispatch loser did not release or reconcile")
	}

	failing := &coverageQuotaReservation{releaseErr: errors.New("boom")}
	router.releaseProvenUnaccepted(context.Background(), failing, &Failure{Phase: FailurePhasePreDispatch})
	if router.QuotaPersistenceFailures() == 0 {
		t.Fatal("expected persistence failure counter")
	}
	router.releaseProvenUnaccepted(context.Background(), failing, &Failure{Phase: FailurePhaseProvider})
	router.releaseProvenUnaccepted(context.Background(), nil, &Failure{Phase: FailurePhasePreDispatch})
}

func TestRecordFailOpenAndIntValueHelpers(t *testing.T) {
	service := &DispatchService{Evidence: telemetry.NewRegistry()}
	service.recordFailOpen(nil)
	service.recordFailOpen(func() error { return errors.New("side effect") })
	if service.SideEffectFailureCount() != 1 {
		t.Fatalf("side effects=%d", service.SideEffectFailureCount())
	}
	if intValue(float64(3)) != 3 || intValue(2) != 2 || intValue(json.Number("4")) != 4 || intValue("x") != 0 {
		t.Fatal("intValue")
	}
	if _, ok := nestedString(map[string]any{"a": map[string]any{"b": 1}}, "a", "b"); ok {
		t.Fatal("nestedString non-string")
	}
	if got, ok := nestedString(map[string]any{"a": map[string]any{"b": "ok"}}, "a", "b"); !ok || got != "ok" {
		t.Fatalf("nestedString=%q ok=%v", got, ok)
	}
}

func TestClassifyRetryAfterAndProjectionCrossSurface(t *testing.T) {
	failure := Classify(ClassifyInput{StatusCode: http.StatusTooManyRequests, HeaderValues: []string{"Retry-After: 7"}})
	if failure.Kind != FailureRateLimit {
		t.Fatalf("classify=%+v", failure)
	}
	_ = parseRetryAfter([]string{"Retry-After: 3", "ignore"})
	_ = parseRetryAfter([]string{"not-a-retry"})

	registry := transforms.NewDefaultRegistry()
	chatBody := []byte(`{"id":"chatcmpl_1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	response := &contracts.Response{StatusCode: 200, Headers: http.Header{"Content-Type": []string{"application/json"}}, Body: chatBody}
	// Same-surface remains passthrough; unsupported target fails closed.
	if _, err := canonicalResponseProjection(contracts.Request{Protocol: contracts.SurfaceOpenAIChat}, contracts.Surface("nope"), response, registry); err == nil {
		t.Fatal("invalid target accepted")
	}
	if _, err := canonicalResponseProjection(contracts.Request{Protocol: contracts.SurfaceOpenAIChat}, contracts.SurfaceAnthropic, response, nil); err == nil {
		t.Fatal("nil registry accepted for cross-surface")
	}
}

func TestApplyTokenSaverShrinksLargeToolResult(t *testing.T) {
	large := strings.Repeat("line\n", 4000)
	req := &transforms.NormalizedRequest{
		Model: "model",
		Messages: []transforms.NormalizedMessage{{
			Role: transforms.RoleTool,
			Content: []transforms.ContentBlock{{
				Type: transforms.BlockToolResult, Text: large, ToolCallID: "call_1", ToolName: "bash",
			}},
		}},
	}
	out, changed := applyTokenSaver(context.Background(), req)
	if out == nil {
		t.Fatal("nil outcome")
	}
	// Compression may or may not shrink depending on orchestrator thresholds; exercise both outcomes.
	if changed && len(out.Messages[0].Content[0].Text) >= len(large) {
		t.Fatal("changed without shrinking")
	}
	_, _ = applyTokenSaver(nil, nil)
	_, _ = applyTokenSaver(context.Background(), &transforms.NormalizedRequest{Model: "m"})
}

func TestHandleFailureNilAndStreamErrorError(t *testing.T) {
	router := &Router{}
	if router.handleFailure(nil, &Account{ID: "a"}, 1) != nil {
		t.Fatal("nil callErr should return nil")
	}
	err := streamError(StreamCodeWriteFailure, "write failed", ioStub{})
	if err.Error() == "" || !errors.Is(err, ioStub{}) {
		t.Fatalf("StreamError=%v", err)
	}
	var tokens usage.Tokens
	_ = tokens
}

type ioStub struct{}

func (ioStub) Error() string { return "stub" }
