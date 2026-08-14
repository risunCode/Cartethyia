package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/observability/usage"
	"github.com/cartethyia/daemon/internal/proxy/control/admission"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

type lifecycleStore struct{ accounts []Account }

func (s lifecycleStore) ListAccounts(context.Context, string) ([]Account, error) {
	return append([]Account(nil), s.accounts...), nil
}

type lifecycleTransport struct {
	calls    int
	failures map[string]error
	response *contracts.Response
	wait     bool
}

type metadataCollector struct{ values []observability.Metadata }

func (c *metadataCollector) Enqueue(value observability.Metadata) error {
	c.values = append(c.values, value)
	return nil
}

func (t *lifecycleTransport) Call(ctx context.Context, acct Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls++
	if t.wait {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if err := t.failures[acct.ID]; err != nil {
		return nil, err
	}
	if t.response != nil {
		return t.response, nil
	}
	return &contracts.Response{StatusCode: http.StatusOK, Headers: http.Header{"Content-Type": []string{"application/json"}}, Body: []byte(`{"ok":true}`)}, nil
}

func newLifecycleService(t *testing.T, transport Transport, maxAttempts int) (*DispatchService, *admission.Limiter) {
	t.Helper()
	pool, err := NewAccountPool(PoolConfig{Store: lifecycleStore{accounts: []Account{
		{ID: "a", Provider: "openai", Enabled: true},
		{ID: "b", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: maxAttempts})
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := admission.New(admission.Layer{Name: "global", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	return &DispatchService{Router: router, Transport: transport, Admission: limiter}, limiter
}

func lifecycleRequest() *contracts.Request {
	return &contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{"model":"model","messages":[{"role":"user","content":"hello"}]}`), Headers: http.Header{"X-Request-ID": []string{"lifecycle-1"}}}
}

func TestDispatchLifecycleSuccessReleasesAdmissionOnce(t *testing.T) {
	transport := &lifecycleTransport{}
	service, limiter := newLifecycleService(t, transport, 2)
	service.Usage = usage.New()
	stream, err := service.DispatchContext(context.Background(), lifecycleRequest())
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	body, err := io.ReadAll(stream.Body())
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if string(body) != `{"ok":true}` {
		t.Fatalf("body = %s", body)
	}
	if got := limiter.Usage()["global"]; got != 0 {
		t.Fatalf("global admission usage = %d, want 0", got)
	}
	if transport.calls != 1 {
		t.Fatalf("provider calls = %d, want 1", transport.calls)
	}
	events := service.Usage.Attempts("lifecycle-1")
	if len(events) != 1 || events[0].RequestID != "lifecycle-1" {
		t.Fatalf("usage events = %#v", events)
	}
}

func TestDispatchValidationDoesNotAcquireOrCallProvider(t *testing.T) {
	transport := &lifecycleTransport{}
	service, limiter := newLifecycleService(t, transport, 2)
	_, err := service.DispatchContext(context.Background(), &contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Body: []byte(`{"messages":[]}`)})
	if err == nil {
		t.Fatal("expected validation error")
	}
	var routeErr *contracts.RouteError
	if !errors.As(err, &routeErr) || routeErr.Kind != contracts.ErrorInvalidRequest {
		t.Fatalf("error = %T %v", err, err)
	}
	if transport.calls != 0 || limiter.Usage()["global"] != 0 {
		t.Fatalf("validation performed work: calls=%d usage=%d", transport.calls, limiter.Usage()["global"])
	}
}

func TestDispatchRetriesTypedProviderFailure(t *testing.T) {
	transport := &lifecycleTransport{failures: map[string]error{
		"a": &contracts.RouteError{Kind: contracts.ErrorTransient, StatusCode: http.StatusBadGateway, Message: "temporary"},
	}}
	service, limiter := newLifecycleService(t, transport, 2)
	if _, err := service.DispatchContext(context.Background(), lifecycleRequest()); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if transport.calls != 2 {
		t.Fatalf("provider calls = %d, want bounded fallback of 2", transport.calls)
	}
	if limiter.Usage()["global"] != 0 {
		t.Fatal("admission lease leaked after retry")
	}
}

func TestDispatchProviderFailureIsClassified(t *testing.T) {
	transport := &lifecycleTransport{failures: map[string]error{
		"a": &contracts.RouteError{Kind: contracts.ErrorAuthentication, StatusCode: http.StatusUnauthorized, Message: "unauthorized"},
	}}
	service, limiter := newLifecycleService(t, transport, 1)
	_, err := service.DispatchContext(context.Background(), lifecycleRequest())
	if err == nil {
		t.Fatal("expected provider failure")
	}
	var routeErr *contracts.RouteError
	if !errors.As(err, &routeErr) || routeErr.Kind != contracts.ErrorAuthentication {
		t.Fatalf("error = %T %v", err, err)
	}
	if limiter.Usage()["global"] != 0 {
		t.Fatal("admission lease leaked after provider failure")
	}
}

func TestDispatchAdmissionCancellationAndDeadline(t *testing.T) {
	transport := &lifecycleTransport{}
	service, limiter := newLifecycleService(t, transport, 1)
	held, err := limiter.Acquire(context.Background(), map[string]string{"global": "global"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = service.DispatchContext(ctx, lifecycleRequest())
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error = %v", err)
	}
	held.Release()
	if limiter.Usage()["global"] != 0 || transport.calls != 0 {
		t.Fatalf("cancellation leaked state: usage=%d calls=%d", limiter.Usage()["global"], transport.calls)
	}

	deadlineTransport := &lifecycleTransport{wait: true}
	deadlineService, deadlineLimiter := newLifecycleService(t, deadlineTransport, 2)
	deadlineCtx, deadlineCancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer deadlineCancel()
	_, err = deadlineService.DispatchContext(deadlineCtx, lifecycleRequest())
	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline error = %v", err)
	}
	if deadlineLimiter.Usage()["global"] != 0 {
		t.Fatal("admission lease leaked after deadline")
	}
}

func TestDispatchRejectsMalformedProviderResult(t *testing.T) {
	transport := &lifecycleTransport{response: &contracts.Response{StatusCode: http.StatusOK, Body: []byte("not-json")}}
	service, limiter := newLifecycleService(t, transport, 1)
	_, err := service.DispatchContext(context.Background(), lifecycleRequest())
	if err == nil {
		t.Fatal("expected malformed provider response")
	}
	var routeErr *contracts.RouteError
	if !errors.As(err, &routeErr) || routeErr.Kind != contracts.ErrorFatal {
		t.Fatalf("error = %T %v", err, err)
	}
	if limiter.Usage()["global"] != 0 {
		t.Fatal("admission lease leaked after malformed response")
	}
}

func TestDispatchProjectsNativeResponsesForChatClient(t *testing.T) {
	transport := &lifecycleTransport{response: &contracts.Response{
		StatusCode: http.StatusOK,
		Headers:    http.Header{"Content-Type": []string{"application/json"}},
		Body:       []byte(`{"id":"resp_1","object":"response","created_at":1700000000,"model":"gpt-5.6","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":4,"output_tokens":2}}`),
	}}
	service, _ := newLifecycleService(t, transport, 1)
	stream, err := service.DispatchContext(context.Background(), lifecycleRequest())
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	body, err := io.ReadAll(stream.Body())
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	var projected map[string]any
	if err := json.Unmarshal(body, &projected); err != nil {
		t.Fatalf("decode projected response: %v", err)
	}
	if projected["object"] != "chat.completion" {
		t.Fatalf("object = %#v", projected["object"])
	}
	choices, ok := projected["choices"].([]any)
	if !ok || len(choices) != 1 {
		t.Fatalf("choices = %#v", projected["choices"])
	}
	choice := choices[0].(map[string]any)
	message := choice["message"].(map[string]any)
	if message["content"] != "hello" || choice["finish_reason"] != "stop" {
		t.Fatalf("choice = %#v", choice)
	}
}

func TestDispatchEnqueuesMetadataExactlyOnce(t *testing.T) {
	service, _ := newLifecycleService(t, &lifecycleTransport{}, 1)
	collector := &metadataCollector{}
	service.Metadata = collector
	stream, err := service.DispatchContext(context.Background(), lifecycleRequest())
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if _, err := io.ReadAll(stream.Body()); err != nil {
		t.Fatalf("read response: %v", err)
	}
	if len(collector.values) != 1 {
		t.Fatalf("metadata count = %d, want 1", len(collector.values))
	}
	value := collector.values[0]
	if value.Outcome != observability.OutcomeSuccess || value.MessageCount != 1 || value.RequestID != "lifecycle-1" {
		t.Fatalf("metadata = %#v", value)
	}
}

func TestNativeResponsesProjectionPreservesToolAndCacheUsage(t *testing.T) {
	response := projectNativeResponsesToChat(contracts.Request{Protocol: contracts.SurfaceOpenAIChat}, &contracts.Response{Body: []byte(`{"id":"resp","object":"response","output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup","arguments":"{\"q\":\"x\"}"}],"usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14,"input_tokens_details":{"cached_tokens":6}}}`)})
	var body map[string]any
	if err := json.Unmarshal(response.Body, &body); err != nil {
		t.Fatal(err)
	}
	choice := body["choices"].([]any)[0].(map[string]any)
	message := choice["message"].(map[string]any)
	if choice["finish_reason"] != "tool_calls" || len(message["tool_calls"].([]any)) != 1 {
		t.Fatalf("tool projection = %#v", message)
	}
	usage := body["usage"].(map[string]any)
	if usage["prompt_tokens"] != float64(10) || usage["prompt_tokens_details"].(map[string]any)["cached_tokens"] != float64(6) {
		t.Fatalf("usage projection = %#v", usage)
	}
}
