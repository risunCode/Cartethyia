package transport

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/providers/adapters"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	proxy "github.com/cartethyia/daemon/internal/proxy/runtime"
	"github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
)

const transportSecretSentinel = "proxy-password-SENTINEL-transport"

type regressionRoundTripper func(*http.Request) (*http.Response, error)

func (f regressionRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

type failingReadCloser struct {
	err    error
	closed atomic.Bool
}

func (r *failingReadCloser) Read([]byte) (int, error) { return 0, r.err }
func (r *failingReadCloser) Close() error {
	r.closed.Store(true)
	return nil
}

func newStreamRegressionTransport(t *testing.T, roundTripper http.RoundTripper, releaseCalls *atomic.Int32) *HTTPTransport {
	t.Helper()
	registry := providers.NewRegistry()
	if err := registry.Register(providers.NewAgentRouterAdapter()); err != nil {
		t.Fatalf("register provider: %v", err)
	}
	return &HTTPTransport{
		Registry: registry,
		Client:   &http.Client{Transport: roundTripper},
		BaseURLs: map[string]string{"agentrouter": "https://fixture.invalid"},
		ResolveCredential: func(context.Context, string) (string, error) {
			return "credential-SENTINEL-upstream-request", nil
		},
		ProxySelector: func(context.Context, string, string) (ProxySelection, error) {
			return ProxySelection{
				ID: "proxy-fixture",
				Release: func() {
					releaseCalls.Add(1)
				},
			}, nil
		},
	}
}

func streamRegressionRequest() contracts.Request {
	return contracts.Request{
		Protocol: contracts.SurfaceAnthropic,
		Model:    "claude-opus-4-8",
		Body:     []byte(`{"model":"claude-opus-4-8","messages":[]}`),
		Stream:   true,
	}
}

func streamRegressionAccount() proxy.Account {
	return proxy.Account{ID: "account-fixture", Provider: "agentrouter", Enabled: true}
}

func TestHTTPTransportClassifiesStreamingConnectErrorsAndRedactsEvidence(t *testing.T) {
	var upstreamCalls atomic.Int32
	var releaseCalls atomic.Int32
	var failureEvidence string
	transport := newStreamRegressionTransport(t, regressionRoundTripper(func(*http.Request) (*http.Response, error) {
		upstreamCalls.Add(1)
		return nil, errors.New("dial proxy failed with " + transportSecretSentinel)
	}), &releaseCalls)
	transport.ProxyFailure = func(_ context.Context, proxyID, kind, message string) {
		failureEvidence = strings.Join([]string{proxyID, kind, message}, ":")
	}

	stream, err := transport.CallStream(context.Background(), streamRegressionAccount(), streamRegressionRequest())
	if stream != nil {
		stream.Close()
		t.Fatal("CallStream returned a stream after connect failure")
	}
	var routeErr *contracts.RouteError
	if !errors.As(err, &routeErr) {
		t.Fatalf("error=%T %v, want RouteError", err, err)
	}
	if routeErr.Kind != contracts.ErrorTransient || !routeErr.Retryable {
		t.Fatalf("classification kind=%q retryable=%v, want transient retryable", routeErr.Kind, routeErr.Retryable)
	}
	if routeErr.Code == "" {
		t.Fatal("streaming connect failure has no stable code")
	}
	if strings.Contains(err.Error(), transportSecretSentinel) {
		t.Fatalf("client error leaked proxy sentinel: %q", err)
	}
	if strings.Contains(failureEvidence, transportSecretSentinel) {
		t.Fatalf("proxy failure evidence leaked sentinel: %q", failureEvidence)
	}
	if got := upstreamCalls.Load(); got != 1 {
		t.Fatalf("upstream calls=%d, want 1", got)
	}
	if got := releaseCalls.Load(); got != 1 {
		t.Fatalf("proxy releases=%d, want 1", got)
	}
}

func TestHTTPTransportStreamFailureAndTerminalBoundaries(t *testing.T) {
	providerErrorFrame := "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"" + transportSecretSentinel + "\"}}\n\n"
	messageStartFrame := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_fixture\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-opus-4-8\",\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n"
	terminalFrame := "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"

	tests := []struct {
		name          string
		body          func() io.ReadCloser
		wantCode      string
		wantEvents    int
		wantTerminals int
	}{
		{
			name: "reader failure is coded",
			body: func() io.ReadCloser {
				return &failingReadCloser{err: errors.New("reader failed with " + transportSecretSentinel)}
			},
			wantCode: proxy.StreamCodeReadFailure,
		},
		{
			name:     "EOF without terminal is truncation",
			body:     func() io.ReadCloser { return io.NopCloser(strings.NewReader(messageStartFrame)) },
			wantCode: proxy.StreamCodeUpstreamTruncated,
		},
		{
			name:     "first provider error remains pre-commit",
			body:     func() io.ReadCloser { return io.NopCloser(strings.NewReader(providerErrorFrame)) },
			wantCode: proxy.StreamCodeUpstreamFailure,
		},
		{
			name:          "terminal-only success is replayed",
			body:          func() io.ReadCloser { return io.NopCloser(strings.NewReader(terminalFrame)) },
			wantEvents:    1,
			wantTerminals: 1,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var upstreamCalls atomic.Int32
			var releaseCalls atomic.Int32
			transport := newStreamRegressionTransport(t, regressionRoundTripper(func(*http.Request) (*http.Response, error) {
				upstreamCalls.Add(1)
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": {"text/event-stream"}},
					Body:       test.body(),
				}, nil
			}), &releaseCalls)

			stream, err := transport.CallStream(context.Background(), streamRegressionAccount(), streamRegressionRequest())
			if err != nil {
				t.Fatalf("CallStream error=%v", err)
			}
			if stream == nil {
				t.Fatal("CallStream returned nil stream")
			}
			defer stream.Close()

			preflightErr := stream.Preflight(context.Background())
			if test.wantCode != "" {
				if got := proxy.StreamCodeOf(preflightErr); got != test.wantCode {
					t.Fatalf("Preflight code=%q, want %q (err=%v)", got, test.wantCode, preflightErr)
				}
				if strings.Contains(preflightErr.Error(), transportSecretSentinel) {
					t.Fatalf("preflight error leaked sentinel: %q", preflightErr)
				}
			} else {
				if preflightErr != nil {
					t.Fatalf("Preflight error=%v", preflightErr)
				}
				eventCount := 0
				terminalCount := 0
				for {
					event, nextErr := stream.Next(context.Background())
					if nextErr != nil {
						if errors.Is(nextErr, io.EOF) {
							break
						}
						t.Fatalf("Next error=%v", nextErr)
					}
					eventCount++
					if event.IsTerminal() {
						terminalCount++
						break
					}
				}
				if terminalCount != test.wantTerminals {
					t.Fatalf("terminal output count=%d, want %d", terminalCount, test.wantTerminals)
				}
				if eventCount != test.wantEvents {
					t.Fatalf("replayed output count=%d, want %d", eventCount, test.wantEvents)
				}
			}
			if got := upstreamCalls.Load(); got != 1 {
				t.Fatalf("upstream calls=%d, want 1", got)
			}
			if got := releaseCalls.Load(); got != 1 {
				t.Fatalf("proxy releases=%d, want 1", got)
			}
		})
	}
}

type classificationProvider struct {
	*providers.AgentRouterAdapter
	classified providers.ClassifiedResponse
	evidence   providers.ResponseEvidence
}

func (p *classificationProvider) ClassifyResponse(evidence providers.ResponseEvidence) providers.ClassifiedResponse {
	p.evidence = evidence
	return p.classified
}

func TestHTTPTransportPreservesEveryProviderResponseCategory(t *testing.T) {
	const bodySentinel = "prompt-SENTINEL-classified-response-body"
	tests := []struct {
		name      string
		category  providers.ResponseCategory
		wantKind  contracts.ErrorKind
		retryable bool
		alternate bool
	}{
		{name: "auth", category: providers.CategoryAuth, wantKind: contracts.ErrorAuthentication, retryable: true, alternate: true},
		{name: "entitlement", category: providers.CategoryEntitlement, wantKind: contracts.ErrorEntitlement},
		{name: "rate limit", category: providers.CategoryRateLimit, wantKind: contracts.ErrorRateLimit, retryable: true, alternate: true},
		{name: "quota", category: providers.CategoryQuota, wantKind: contracts.ErrorQuota, retryable: true, alternate: true},
		{name: "capacity", category: providers.CategoryCapacity, wantKind: contracts.ErrorCapacity, retryable: true, alternate: true},
		{name: "content policy", category: providers.CategoryContentPolicy, wantKind: contracts.ErrorContentPolicy},
		{name: "empty output", category: providers.CategoryEmptyOutput, wantKind: contracts.ErrorEmptyOutput},
		{name: "invalid request", category: providers.CategoryInvalidRequest, wantKind: contracts.ErrorInvalidRequest},
		{name: "transient", category: providers.CategoryTransient, wantKind: contracts.ErrorTransient, retryable: true, alternate: true},
		{name: "server error", category: providers.CategoryServerError, wantKind: contracts.ErrorServerError, retryable: true, alternate: true},
		{name: "fatal", category: providers.CategoryFatal, wantKind: contracts.ErrorFatal},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var upstreamCalls atomic.Int32
			var releaseCalls atomic.Int32
			provider := &classificationProvider{
				AgentRouterAdapter: providers.NewAgentRouterAdapter(),
				classified: providers.ClassifiedResponse{
					StatusCode:               http.StatusTeapot,
					Retryable:                test.retryable,
					AlternateAccountEligible: test.alternate,
					Category:                 test.category,
					Code:                     "provider.fixture_" + string(test.category),
					RetryAfter:               2750 * time.Millisecond,
					Phase:                    contracts.RatePhaseProvider,
					Scope:                    contracts.RateScopeAccount,
					Message:                  "bounded provider failure",
				},
			}
			registry := providers.NewRegistry()
			if err := registry.Register(provider); err != nil {
				t.Fatalf("register provider: %v", err)
			}
			transport := &HTTPTransport{
				Registry: registry,
				Client: &http.Client{Transport: regressionRoundTripper(func(*http.Request) (*http.Response, error) {
					upstreamCalls.Add(1)
					return &http.Response{
						StatusCode: http.StatusTeapot,
						Header: http.Header{
							"Retry-After": {"3"},
							"Set-Cookie":  {"session=credential-SENTINEL-cookie"},
						},
						Body: io.NopCloser(strings.NewReader(`{"error":"` + bodySentinel + `"}`)),
					}, nil
				})},
				BaseURLs: map[string]string{"agentrouter": "https://fixture.invalid"},
				ResolveCredential: func(context.Context, string) (string, error) {
					return "credential-SENTINEL-classification-request", nil
				},
				ProxySelector: func(context.Context, string, string) (ProxySelection, error) {
					return ProxySelection{ID: "proxy-fixture", Release: func() { releaseCalls.Add(1) }}, nil
				},
			}

			response, err := transport.Call(context.Background(), streamRegressionAccount(), streamRegressionRequest())
			if response != nil {
				t.Fatalf("response=%#v, want nil classified failure", response)
			}
			var routeErr *contracts.RouteError
			if !errors.As(err, &routeErr) {
				t.Fatalf("error=%T %v, want RouteError", err, err)
			}
			if routeErr.Kind != test.wantKind || routeErr.StatusCode != http.StatusTeapot {
				t.Fatalf("kind=%q status=%d, want %q/418", routeErr.Kind, routeErr.StatusCode, test.wantKind)
			}
			if routeErr.Code != provider.classified.Code || routeErr.Retryable != test.retryable || routeErr.AlternateAccountEligible != test.alternate {
				t.Fatalf("decision not preserved: route=%+v provider=%+v", routeErr, provider.classified)
			}
			if routeErr.RetryAfterMS != 2750 || routeErr.Phase != contracts.RatePhaseProvider || routeErr.Scope != contracts.RateScopeAccount {
				t.Fatalf("timing/scope not preserved: %+v", routeErr)
			}
			if provider.evidence.StatusCode != http.StatusTeapot || provider.evidence.Headers.RetryAfter != "3" || !strings.Contains(string(provider.evidence.BodyPrefix), bodySentinel) {
				t.Fatalf("bounded classifier evidence not delivered: %+v", provider.evidence)
			}
			code, retryable, retryAfterMS, alternate, source, scope, phase := routeErr.LifecycleEvidence()
			clientEvidence := strings.Join([]string{err.Error(), code, source, scope, phase}, "|")
			if strings.Contains(clientEvidence, bodySentinel) || strings.Contains(clientEvidence, "credential-SENTINEL") || strings.Contains(clientEvidence, "proxy-password-SENTINEL") {
				t.Fatalf("client/lifecycle evidence leaked sentinel: %q", clientEvidence)
			}
			if retryable != test.retryable || alternate != test.alternate || retryAfterMS != 2750 {
				t.Fatalf("lifecycle decision retryable=%v alternate=%v retryAfter=%d", retryable, alternate, retryAfterMS)
			}
			if got := upstreamCalls.Load(); got != 1 {
				t.Fatalf("upstream calls=%d, want 1", got)
			}
			if got := releaseCalls.Load(); got != 1 {
				t.Fatalf("proxy releases=%d, want 1", got)
			}
		})
	}
}

func TestHTTPTransportSuccessfulCategoryReturnsOneResponse(t *testing.T) {
	var upstreamCalls atomic.Int32
	provider := &classificationProvider{
		AgentRouterAdapter: providers.NewAgentRouterAdapter(),
		classified: providers.ClassifiedResponse{
			StatusCode: http.StatusOK,
			Category:   providers.CategorySuccess,
			Code:       "provider.success",
			Message:    "success",
		},
	}
	registry := providers.NewRegistry()
	if err := registry.Register(provider); err != nil {
		t.Fatalf("register provider: %v", err)
	}
	transport := &HTTPTransport{
		Registry: registry,
		Client: &http.Client{Transport: regressionRoundTripper(func(*http.Request) (*http.Response, error) {
			upstreamCalls.Add(1)
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": {"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
			}, nil
		})},
		BaseURLs:          map[string]string{"agentrouter": "https://fixture.invalid"},
		ResolveCredential: func(context.Context, string) (string, error) { return "credential-ref", nil },
	}
	response, err := transport.Call(context.Background(), streamRegressionAccount(), streamRegressionRequest())
	if err != nil || response == nil || response.StatusCode != http.StatusOK {
		t.Fatalf("response=%#v err=%v", response, err)
	}
	if got := upstreamCalls.Load(); got != 1 {
		t.Fatalf("upstream calls=%d, want 1", got)
	}
}

type grokAccountStore struct{ account proxy.Account }

func (s grokAccountStore) ListAccounts(context.Context, string) ([]proxy.Account, error) {
	return []proxy.Account{s.account}, nil
}

func decodeGrokRepairBody(t *testing.T, body string) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("decode Grok request body: %v", err)
	}
	return payload
}

func grokRepairBodyHasEncryptedContent(payload map[string]any) bool {
	if input, ok := payload["input"].([]any); ok {
		for _, item := range input {
			if block, ok := item.(map[string]any); ok && block["type"] == "reasoning" {
				_, exists := block["encrypted_content"]
				return exists
			}
		}
	}
	return false
}

func normalizedGrokRepairBody(t *testing.T, body string) map[string]any {
	t.Helper()
	payload := decodeGrokRepairBody(t, body)
	// The cache key is adapter-owned and intentionally derived from the final
	// request body, so removing encrypted content is expected to recompute it.
	delete(payload, "prompt_cache_key")
	if input, ok := payload["input"].([]any); ok {
		for _, item := range input {
			if block, ok := item.(map[string]any); ok && block["type"] == "reasoning" {
				delete(block, "encrypted_content")
			}
		}
	}
	return payload
}

func TestRouterCountsEveryHTTPTransportGrokRepairCall(t *testing.T) {
	modelCaps := &providers.ProviderCaps{
		Surfaces:       []providers.Surface{providers.SurfaceOpenAIResponses},
		Streaming:      true,
		Reasoning:      true,
		ToolCalls:      true,
		PromptCacheKey: true,
	}
	provider := adapters.NewGrokBuildAdapter(adapters.GrokBuildConfig{
		Models: []providers.ProviderModel{providers.Model("grok-test", "Grok Test", modelCaps)},
	})
	registry := providers.NewRegistry()
	if err := registry.Register(provider); err != nil {
		t.Fatalf("register provider: %v", err)
	}
	var upstreamCalls atomic.Int32
	requestBodies := make([]string, 0, 2)
	accountOrder := make([]string, 0, 2)
	var proxyReleases atomic.Int32
	transport := &HTTPTransport{
		Registry: registry,
		Client: &http.Client{Transport: regressionRoundTripper(func(request *http.Request) (*http.Response, error) {
			call := upstreamCalls.Add(1)
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatalf("read upstream request: %v", err)
			}
			requestBodies = append(requestBodies, string(body))
			if call == 1 {
				return &http.Response{
					StatusCode: http.StatusBadRequest,
					Header:     http.Header{"Content-Type": {"application/json"}},
					Body:       io.NopCloser(strings.NewReader(`{"error":{"code":"invalid_encrypted_content"}}`)),
				}, nil
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": {"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"id":"response-fixture","output":[]}`)),
			}, nil
		})},
		BaseURLs: map[string]string{"grok-build": "https://fixture.invalid"},
		ResolveCredential: func(context.Context, string) (string, error) {
			return "credential-SENTINEL-grok", nil
		},
		ProxySelector: func(_ context.Context, _ string, accountID string) (ProxySelection, error) {
			accountOrder = append(accountOrder, accountID)
			return ProxySelection{ID: "proxy-fixture", Release: func() { proxyReleases.Add(1) }}, nil
		},
	}
	pool, err := proxy.NewAccountPool(proxy.PoolConfig{Store: grokAccountStore{account: proxy.Account{
		ID: "grok-account", Provider: "grok-build", Enabled: true,
	}}})
	if err != nil {
		t.Fatalf("NewAccountPool: %v", err)
	}
	var repairEvidence []proxy.RepairEvidence
	router, err := proxy.NewRouter(proxy.RouterConfig{
		Pool: pool, MaxAttempts: 2,
		RepairObserver: func(item proxy.RepairEvidence) { repairEvidence = append(repairEvidence, item) },
	})
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	request := contracts.Request{
		Protocol: contracts.SurfaceOpenAIResponses,
		Model:    "grok-test",
		Body:     []byte(`{"input":[{"type":"reasoning","summary":[{"type":"summary_text","text":"summary-SENTINEL-grok"}],"encrypted_content":"cipher"},{"type":"message","role":"user","content":[{"type":"input_text","text":"prompt-SENTINEL-grok"},{"type":"input_image","image_url":"data:image/png;base64,image-SENTINEL-grok"},{"type":"tool_result","tool_call_id":"call-SENTINEL-grok","output":{"answer":"tool-result-SENTINEL-grok","encrypted_content":"user-owned-SENTINEL-grok"}}]},{"type":"function_call_output","call_id":"call-SENTINEL-grok","output":"tool-output-SENTINEL-grok"}],"tools":[{"type":"function","function":{"name":"tool-SENTINEL-grok","description":"tool-description-SENTINEL-grok"}}]}`),
	}

	plan := catalog.RoutePlan{
		RequestedModel: request.Model,
		Strategy:       catalog.RouteStrategySingle,
		Members: []catalog.RouteMember{{
			ProviderID: "grok-build", ClientModelID: request.Model,
			UpstreamModelID: request.Model, Surface: request.Protocol,
		}},
	}
	response, failure, routeErr := router.Route(context.Background(), transport, request, plan)
	if routeErr != nil || failure != nil || response == nil || response.StatusCode != http.StatusOK {
		t.Fatalf("response=%#v failure=%#v err=%v", response, failure, routeErr)
	}
	if got := upstreamCalls.Load(); got != 2 {
		t.Fatalf("actual upstream HTTP calls=%d, want exactly 2 visible attempts", got)
	}
	if len(accountOrder) != 2 || accountOrder[0] != "grok-account" || accountOrder[1] != "grok-account" {
		t.Fatalf("candidate order=%v, want same account twice for bounded repair", accountOrder)
	}
	if len(requestBodies) != 2 || requestBodies[0] == requestBodies[1] {
		t.Fatalf("repair bodies were not distinct: count=%d", len(requestBodies))
	}
	firstDecoded := decodeGrokRepairBody(t, requestBodies[0])
	secondDecoded := decodeGrokRepairBody(t, requestBodies[1])
	if !grokRepairBodyHasEncryptedContent(firstDecoded) || grokRepairBodyHasEncryptedContent(secondDecoded) {
		t.Fatalf("repair did not remove only encrypted-content replay trigger: first=%s second=%s", requestBodies[0], requestBodies[1])
	}
	for _, sentinel := range []string{"prompt-SENTINEL-grok", "image-SENTINEL-grok", "tool-result-SENTINEL-grok", "tool-output-SENTINEL-grok", "user-owned-SENTINEL-grok"} {
		if !strings.Contains(requestBodies[0], sentinel) || !strings.Contains(requestBodies[1], sentinel) {
			t.Fatalf("repair did not preserve user-authored %q: first=%s second=%s", sentinel, requestBodies[0], requestBodies[1])
		}
	}
	firstNormalized := normalizedGrokRepairBody(t, requestBodies[0])
	secondNormalized := normalizedGrokRepairBody(t, requestBodies[1])
	if !reflect.DeepEqual(firstNormalized, secondNormalized) {
		t.Fatalf("repair changed fields other than encrypted_content and derived prompt_cache_key: first=%v second=%v", firstNormalized, secondNormalized)
	}
	if got := pool.InFlight("grok-account"); got != 0 {
		t.Fatalf("account in-flight=%d after repair success, want 0", got)
	}
	if got := proxyReleases.Load(); got != 2 {
		t.Fatalf("proxy releases=%d, want one per actual HTTP call", got)
	}
	wantEvidence := []proxy.RepairEvidence{{
		Provider: "grok-build", RuleID: adapters.GrokRepairInvalidEncryptedReasoning,
		Attempt: 1, Changed: true,
	}}
	if !reflect.DeepEqual(repairEvidence, wantEvidence) {
		t.Fatalf("repair evidence=%#v, want %#v", repairEvidence, wantEvidence)
	}
}

type crossProviderHTTPAccountStore struct{ accounts []proxy.Account }

func (s crossProviderHTTPAccountStore) ListAccounts(_ context.Context, providerID string) ([]proxy.Account, error) {
	out := make([]proxy.Account, 0, len(s.accounts))
	for _, account := range s.accounts {
		if account.Provider == providerID {
			out = append(out, account)
		}
	}
	return out, nil
}

func TestCrossProviderFallbackHTTPIntegration(t *testing.T) {
	tests := []struct {
		name           string
		firstStatus    int
		secondStatus   int
		planSurface    contracts.Surface
		wantFirst      int32
		wantSecond     int32
		wantSuccess    bool
		wantRouteError bool
	}{
		{name: "eligible fallback", firstStatus: http.StatusServiceUnavailable, secondStatus: http.StatusOK, planSurface: contracts.SurfaceOpenAIChat, wantFirst: 1, wantSecond: 1, wantSuccess: true},
		{name: "explicit stop", firstStatus: http.StatusBadRequest, secondStatus: http.StatusOK, planSurface: contracts.SurfaceOpenAIChat, wantFirst: 1, wantRouteError: true},
		{name: "surface mismatch", firstStatus: http.StatusOK, secondStatus: http.StatusOK, planSurface: contracts.SurfaceAnthropic, wantRouteError: true},
		{name: "global exhaustion", firstStatus: http.StatusServiceUnavailable, secondStatus: http.StatusServiceUnavailable, planSurface: contracts.SurfaceOpenAIChat, wantFirst: 1, wantSecond: 1, wantRouteError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var firstCalls atomic.Int32
			var secondCalls atomic.Int32
			serve := func(counter *atomic.Int32, status int) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					counter.Add(1)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(status)
					if status == http.StatusOK {
						_, _ = io.WriteString(w, `{"id":"chat-fixture","choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
					} else if status == http.StatusBadRequest {
						_, _ = io.WriteString(w, `{"error":{"type":"invalid_request_error","message":"invalid request"}}`)
					} else {
						_, _ = io.WriteString(w, `{"error":{"type":"server_error","message":"temporarily unavailable"}}`)
					}
				}))
			}
			first := serve(&firstCalls, test.firstStatus)
			defer first.Close()
			second := serve(&secondCalls, test.secondStatus)
			defer second.Close()

			registry := providers.NewRegistry()
			for _, provider := range []struct{ id, model string }{{"provider-a", "client-a"}, {"provider-b", "client-b"}} {
				if err := registry.Register(adapters.NewOpenAIAdapter(adapters.OpenAIAdapterConfig{
					ID: provider.id, DisplayName: provider.id, BaseURL: first.URL,
					Surfaces: []providers.Surface{providers.SurfaceOpenAIChat},
					Models:   []providers.ProviderModel{providers.Model(provider.model, provider.model, nil)},
				})); err != nil {
					t.Fatal(err)
				}
			}
			firstRef, err := contracts.NewCredentialRef("cross-provider-account-a")
			if err != nil {
				t.Fatal(err)
			}
			secondRef, err := contracts.NewCredentialRef("cross-provider-account-b")
			if err != nil {
				t.Fatal(err)
			}
			pool, err := proxy.NewAccountPool(proxy.PoolConfig{Store: crossProviderHTTPAccountStore{accounts: []proxy.Account{
				{ID: "account-a", Provider: "provider-a", CredentialRef: firstRef, Enabled: true},
				{ID: "account-b", Provider: "provider-b", CredentialRef: secondRef, Enabled: true},
			}}})
			if err != nil {
				t.Fatal(err)
			}
			router, err := proxy.NewRouter(proxy.RouterConfig{Pool: pool, MaxAttempts: 2})
			if err != nil {
				t.Fatal(err)
			}
			transport := &HTTPTransport{
				Registry:          registry,
				BaseURLs:          map[string]string{"provider-a": first.URL, "provider-b": second.URL},
				ResolveCredential: func(context.Context, string) (string, error) { return "fixture-credential", nil },
			}
			request := contracts.Request{
				Protocol: contracts.SurfaceOpenAIChat,
				Model:    "fallback",
				Headers:  http.Header{"X-Cartethyia-Provider": {"provider-b"}},
				Body:     []byte(`{"model":"fallback","messages":[{"role":"user","content":"hello"}]}`),
			}
			plan := catalog.RoutePlan{RequestedModel: request.Model, Generation: 3, Strategy: catalog.RouteStrategyFallback, Members: []catalog.RouteMember{
				{ProviderID: "provider-a", ClientModelID: "client-a", UpstreamModelID: "upstream-a", Surface: test.planSurface},
				{ProviderID: "provider-b", ClientModelID: "client-b", UpstreamModelID: "upstream-b", Surface: test.planSurface},
			}}
			response, failure, routeErr := router.Route(context.Background(), transport, request, plan)
			if test.wantSuccess {
				if routeErr != nil || failure != nil || response == nil || response.StatusCode != http.StatusOK {
					t.Fatalf("response=%#v failure=%#v routeErr=%v", response, failure, routeErr)
				}
			} else if test.wantRouteError && routeErr == nil && failure == nil {
				t.Fatalf("response=%#v failure=%#v routeErr=%v, want failure", response, failure, routeErr)
			}
			if firstCalls.Load() != test.wantFirst || secondCalls.Load() != test.wantSecond {
				t.Fatalf("calls=(%d,%d), want (%d,%d)", firstCalls.Load(), secondCalls.Load(), test.wantFirst, test.wantSecond)
			}
		})
	}
}
