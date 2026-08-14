package action

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	apicontracts "github.com/cartethyia/daemon/internal/server/api/contracts"
)

type actionProxy struct {
	calls int
	req   *contracts.Request
}

func (p *actionProxy) Dispatch(req *contracts.Request) (apicontracts.Stream, error) {
	p.calls++
	p.req = req
	return actionStream{}, nil
}

type actionStream struct{}

func (actionStream) StatusCode() int      { return http.StatusOK }
func (actionStream) ContentType() string  { return "application/json" }
func (actionStream) Headers() http.Header { return nil }
func (actionStream) Body() apicontracts.StreamReader {
	return io.NopCloser(strings.NewReader(`{"ok":true}`))
}

func actionMux(proxy apicontracts.ProxyService) *http.ServeMux {
	mux := http.NewServeMux()
	Register(mux, Deps{Proxy: proxy})
	return mux
}

func TestActionRejectsNonPost(t *testing.T) {
	proxy := &actionProxy{}
	rec := httptest.NewRecorder()
	actionMux(proxy).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusMethodNotAllowed)
	}
	if proxy.calls != 0 {
		t.Fatalf("dispatch calls=%d want=0", proxy.calls)
	}
}

func TestActionRejectsUnsupportedProtocol(t *testing.T) {
	proxy := &actionProxy{}
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"protocol":"web-search"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	actionMux(proxy).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusBadRequest)
	}
	if proxy.calls != 0 {
		t.Fatalf("dispatch calls=%d want=0", proxy.calls)
	}
}

func TestActionDispatchesCanonicalRequest(t *testing.T) {
	proxy := &actionProxy{}
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"protocol":"openai-chat","model":"gpt-test","stream":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", "req-123")
	rec := httptest.NewRecorder()
	actionMux(proxy).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if proxy.calls != 1 || proxy.req == nil {
		t.Fatalf("dispatch calls=%d req=%v", proxy.calls, proxy.req)
	}
	if proxy.req.Protocol != contracts.SurfaceOpenAIChat || proxy.req.Model != "gpt-test" || !proxy.req.Stream {
		t.Fatalf("request=%+v", proxy.req)
	}
	if proxy.req.Headers.Get("X-Request-Id") != "req-123" {
		t.Fatalf("request id header not propagated")
	}
}
func TestActionEmitsBoundedLifecycleEvidence(t *testing.T) {
	proxy := &actionProxy{}
	metrics := observability.NewRegistry()
	mux := http.NewServeMux()
	Register(mux, Deps{Proxy: proxy, Evidence: metrics})
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"protocol":"openai-chat","model":"gpt-test"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", "req-evidence")
	req.Header.Set("User-Agent", "curl/8.7.1")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if got := metrics.EventCount(observability.StageRequestStart, nil); got != 1 {
		t.Fatalf("start events=%d want=1", got)
	}
	prom := httptest.NewRecorder()
	metrics.ServeHTTP(prom)
	if !strings.Contains(prom.Body.String(), "cartethyia_request_outcomes_total") {
		t.Fatalf("terminal evidence missing: %s", prom.Body.String())
	}
}

func TestActionEmitsTranslatedLifecycleKeysWithoutBody(t *testing.T) {
	proxy := &actionProxy{}
	sink := &observability.CountingSink{}
	recorder := observability.NewRecorder(context.Background(), sink)
	defer recorder.Close(context.Background())
	metrics := observability.NewRegistry().WithRecorder(recorder)
	mux := http.NewServeMux()
	Register(mux, Deps{Proxy: proxy, Evidence: metrics})
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"protocol":"openai-chat","model":"gpt-test","prompt":"do-not-log"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", "req-lifecycle")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	recorder.Close(context.Background())
	events := sink.Events()
	if len(events) != 5 {
		t.Fatalf("events=%d want=5: %+v", len(events), events)
	}
	want := []string{"incoming_request", "route_selected", "provider_attempt", "request_succeeded", "request_completed"}
	for i, key := range want {
		if events[i].EventKey != key {
			t.Errorf("event[%d].EventKey=%q want=%q", i, events[i].EventKey, key)
		}
		for _, field := range events[i].LogFields() {
			if strings.Contains(fmt.Sprint(field.Value), "do-not-log") {
				t.Errorf("event[%d] leaked body text", i)
			}
		}
	}
	if !events[len(events)-1].IsTerminal() || events[len(events)-1].Outcome != observability.OutcomeSuccess {
		t.Fatalf("completion=%+v", events[len(events)-1])
	}
}

type failingActionProxy struct{ err error }

func (p failingActionProxy) Dispatch(*contracts.Request) (apicontracts.Stream, error) {
	return nil, p.err
}

func TestActionFailureKeepsSpecificCodeAndCompletion(t *testing.T) {
	proxy := failingActionProxy{err: &contracts.RouteError{
		Kind: contracts.ErrorRateLimit, StatusCode: http.StatusTooManyRequests,
		Code: "provider.rate_limit", Message: "rate limited", Retryable: true,
		RetryAfterMS: 5000, AlternateAccountEligible: true,
		RateSource: contracts.RateSourceProviderRate, RateScope: contracts.RateScopeProvider,
		RatePhase: contracts.RatePhaseProvider,
	}}
	sink := &observability.CountingSink{}
	recorder := observability.NewRecorder(context.Background(), sink)
	defer recorder.Close(context.Background())
	metrics := observability.NewRegistry().WithRecorder(recorder)
	mux := http.NewServeMux()
	Register(mux, Deps{Proxy: proxy, Evidence: metrics})
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"protocol":"openai-chat","model":"gpt-test"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	recorder.Close(context.Background())
	events := sink.Events()
	if len(events) != 5 {
		t.Fatalf("events=%d want=5: %+v", len(events), events)
	}
	if events[3].EventKey != string(observability.EventRequestFailed) || events[3].ErrorCode != "provider.rate_limit" {
		t.Fatalf("failure event=%+v", events[3])
	}
	if !events[3].Retryable || events[3].RetryAfterMS != 5000 || !events[3].AlternateAccountEligible {
		t.Fatalf("retry evidence=%+v", events[3])
	}
	if events[4].EventKey != string(observability.EventRequestCompleted) || !events[4].IsTerminal() {
		t.Fatalf("completion event=%+v", events[4])
	}
}

func TestActionCancellationEmitsCancellationAndCompletion(t *testing.T) {
	sink := &observability.CountingSink{}
	recorder := observability.NewRecorder(context.Background(), sink)
	defer recorder.Close(context.Background())
	metrics := observability.NewRegistry().WithRecorder(recorder)
	mux := http.NewServeMux()
	Register(mux, Deps{Proxy: failingActionProxy{err: context.Canceled}, Evidence: metrics})
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"protocol":"openai-chat","model":"gpt-test"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	recorder.Close(context.Background())
	events := sink.Events()
	if len(events) != 5 {
		t.Fatalf("events=%d want=5", len(events))
	}
	if events[3].EventKey != string(observability.EventRequestCancelled) || events[4].Outcome != observability.OutcomeCancelled {
		t.Fatalf("cancellation events=%+v/%+v", events[3], events[4])
	}
}
