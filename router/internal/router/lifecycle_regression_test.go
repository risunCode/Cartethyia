package router

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

const lifecycleSecretSentinel = "credential-SENTINEL-lifecycle-error"

type controlledStreamTransport struct {
	calls         atomic.Int32
	proxyReleases atomic.Int32
	events        chan StreamEvent
	mu            sync.Mutex
	candidateIDs  []string
}

func (t *controlledStreamTransport) CallStream(_ context.Context, account Account, _ contracts.Request) (*Stream, error) {
	t.calls.Add(1)
	t.mu.Lock()
	t.candidateIDs = append(t.candidateIDs, account.ID)
	t.mu.Unlock()
	return NewStream(t.events, func() { t.proxyReleases.Add(1) }, 0, 0), nil
}

func newStreamingLifecycleFixture(t *testing.T, events chan StreamEvent) (*DispatchService, *AccountPool, *Limiter, *controlledStreamTransport) {
	t.Helper()
	pool, err := NewAccountPool(PoolConfig{Store: lifecycleStore{accounts: []Account{
		{ID: "account-a", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatalf("NewAccountPool: %v", err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 1})
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	limiter, err := NewAdmissionLimiter(
		Layer{Name: "global", Limit: 1},
		Layer{Name: "stream", Limit: 1},
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	streamTransport := &controlledStreamTransport{events: events}
	service := &DispatchService{
		Router:          router,
		Transport:       &lifecycleTransport{},
		StreamTransport: streamTransport,
		Admission:       limiter,
	}
	return service, pool, limiter, streamTransport
}

func streamingLifecycleRequest() *contracts.Request {
	return &contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat,
		Model:    "model",
		Body:     []byte(`{"model":"model","stream":true,"messages":[{"role":"user","content":"hello"}]}`),
		Headers: http.Header{
			"X-Request-ID":          {"lifecycle-stream-1"},
			"X-Cartethyia-Provider": {"openai"},
		},
		Stream: true,
	}
}

func assertLifecycleHeld(t *testing.T, pool *AccountPool, limiter *Limiter, transport *controlledStreamTransport) {
	t.Helper()
	if got := transport.calls.Load(); got != 1 {
		t.Fatalf("upstream calls=%d, want 1", got)
	}
	transport.mu.Lock()
	candidateIDs := append([]string(nil), transport.candidateIDs...)
	transport.mu.Unlock()
	if len(candidateIDs) != 1 || candidateIDs[0] != "account-a" {
		t.Fatalf("candidate order=%v, want [account-a]", candidateIDs)
	}
	if got := pool.InFlight("account-a"); got != 1 {
		t.Fatalf("account in-flight=%d before completion, want 1", got)
	}
	if got := limiter.Stats().Active; got != 1 {
		t.Fatalf("active admission leases=%d before completion, want 1", got)
	}
	usage := limiter.Usage()
	if usage["global"] != 1 || usage["stream"] != 1 {
		t.Fatalf("admission usage before completion=%v, want global=1 stream=1", usage)
	}
	if got := transport.proxyReleases.Load(); got != 0 {
		t.Fatalf("proxy releases=%d before completion, want 0", got)
	}
}

func assertLifecycleReleased(t *testing.T, pool *AccountPool, limiter *Limiter, transport *controlledStreamTransport) {
	t.Helper()
	if got := pool.InFlight("account-a"); got != 0 {
		t.Fatalf("account in-flight=%d after completion, want 0", got)
	}
	if got := limiter.Stats().Active; got != 0 {
		t.Fatalf("active admission leases=%d after completion, want 0", got)
	}
	usage := limiter.Usage()
	if usage["global"] != 0 || usage["stream"] != 0 {
		t.Fatalf("admission usage after completion=%v, want zero", usage)
	}
	if got := transport.proxyReleases.Load(); got != 1 {
		t.Fatalf("proxy releases=%d after completion, want exactly 1", got)
	}
}

func TestStreamingLifecycleHoldsAndReleasesEveryLeaseAtTerminalBoundary(t *testing.T) {
	for _, test := range []struct {
		name     string
		terminal StreamEvent
		wantCode string
	}{
		{
			name:     "successful terminal",
			terminal: StreamEvent{Kind: EventMessageStop, Reason: "completed"},
		},
		{
			name: "post-commit provider error",
			terminal: StreamEvent{
				Kind:   EventMessageStop,
				Reason: "error",
				Err:    errors.New("upstream failure " + lifecycleSecretSentinel),
			},
			wantCode: StreamCodeUpstreamFailure,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			events := make(chan StreamEvent, 2)
			events <- StreamEvent{Kind: EventTextDelta, Text: "visible"}
			service, pool, limiter, transport := newStreamingLifecycleFixture(t, events)

			response, err := service.DispatchContext(context.Background(), streamingLifecycleRequest())
			if err != nil {
				t.Fatalf("DispatchContext error=%v", err)
			}
			assertLifecycleHeld(t, pool, limiter, transport)

			events <- test.terminal
			close(events)
			bodyReader := response.Body()
			body, readErr := io.ReadAll(bodyReader)
			if test.wantCode == "" {
				if readErr != nil {
					t.Fatalf("stream read error=%v", readErr)
				}
			} else if got := StreamCodeOf(readErr); got != test.wantCode {
				t.Fatalf("stream read code=%q, want %q (err=%v)", got, test.wantCode, readErr)
			}
			if strings.Count(string(body), "data: [DONE]") != 1 {
				t.Fatalf("terminal output count=%d, want 1; body=%s", strings.Count(string(body), "data: [DONE]"), body)
			}
			if strings.Contains(string(body), lifecycleSecretSentinel) || (readErr != nil && strings.Contains(readErr.Error(), lifecycleSecretSentinel)) {
				t.Fatalf("client stream leaked secret sentinel: body=%q err=%v", body, readErr)
			}

			if err := bodyReader.Close(); err != nil {
				t.Fatalf("Close error=%v", err)
			}
			if err := bodyReader.Close(); err != nil {
				t.Fatalf("repeated Close error=%v", err)
			}
			if aborter, ok := bodyReader.(interface{ Abort(error) }); ok {
				aborter.Abort(errors.New("late abort " + lifecycleSecretSentinel))
			}
			assertLifecycleReleased(t, pool, limiter, transport)
			if got := transport.calls.Load(); got != 1 {
				t.Fatalf("post-commit retry changed upstream calls=%d, want 1", got)
			}
		})
	}
}

func TestStreamingLifecycleAbortReleasesEveryLeaseExactlyOnce(t *testing.T) {
	events := make(chan StreamEvent, 1)
	events <- StreamEvent{Kind: EventTextDelta, Text: "visible"}
	service, pool, limiter, transport := newStreamingLifecycleFixture(t, events)
	response, err := service.DispatchContext(context.Background(), streamingLifecycleRequest())
	if err != nil {
		t.Fatalf("DispatchContext error=%v", err)
	}
	assertLifecycleHeld(t, pool, limiter, transport)

	body := response.Body()
	aborter, ok := body.(interface{ Abort(error) })
	if !ok {
		t.Fatalf("stream body %T does not expose Abort", body)
	}
	aborter.Abort(context.Canceled)
	aborter.Abort(errors.New("repeated abort " + lifecycleSecretSentinel))
	if err := body.Close(); err != nil {
		t.Fatalf("Close after Abort error=%v", err)
	}
	assertLifecycleReleased(t, pool, limiter, transport)
	if got := transport.calls.Load(); got != 1 {
		t.Fatalf("upstream calls=%d after abort, want 1", got)
	}
}

func TestStreamingLifecyclePrecommitErrorReleasesWithoutClientOutput(t *testing.T) {
	events := make(chan StreamEvent, 1)
	events <- StreamEvent{
		Kind:   EventMessageStop,
		Reason: "error",
		Err:    errors.New("precommit provider failure " + lifecycleSecretSentinel),
	}
	close(events)
	service, pool, limiter, transport := newStreamingLifecycleFixture(t, events)

	response, err := service.DispatchContext(context.Background(), streamingLifecycleRequest())
	if response != nil {
		response.Body().Close()
		t.Fatal("precommit failure returned a client stream")
	}
	if err == nil {
		t.Fatal("precommit failure returned nil error")
	}
	if strings.Contains(err.Error(), lifecycleSecretSentinel) {
		t.Fatalf("client error leaked secret sentinel: %q", err)
	}
	assertLifecycleReleased(t, pool, limiter, transport)
	if got := transport.calls.Load(); got != 1 {
		t.Fatalf("upstream calls=%d, want 1", got)
	}
}

func TestStreamingProviderSuccessSurvivesQuotaReconciliationFailure(t *testing.T) {
	events := make(chan StreamEvent, 2)
	events <- StreamEvent{Kind: EventTextDelta, Text: "visible"}
	service, _, _, _ := newStreamingLifecycleFixture(t, events)
	response, err := service.DispatchContext(context.Background(), streamingLifecycleRequest())
	if err != nil {
		t.Fatalf("DispatchContext error=%v", err)
	}
	streamResponse, ok := response.(*streamResponse)
	if !ok {
		t.Fatalf("response type=%T, want *streamResponse", response)
	}
	reservation := &streamQuotaSpy{err: errors.New("quota persistence unavailable")}
	streamResponse.stream.AttachTokenReservation(context.Background(), reservation)
	events <- StreamEvent{Kind: EventMessageStop, Reason: "completed"}
	close(events)

	body, readErr := io.ReadAll(response.Body())
	if readErr != nil {
		t.Fatalf("successful client stream replaced by reconciliation error=%v", readErr)
	}
	if strings.Count(string(body), "data: [DONE]") != 1 {
		t.Fatalf("successful terminal count=%d, want 1; body=%q", strings.Count(string(body), "data: [DONE]"), body)
	}
	if reservation.reconciles != 1 {
		t.Fatalf("reconciles=%d, want 1", reservation.reconciles)
	}
	if service.SideEffectFailureCount() != 1 {
		t.Fatalf("side-effect failures=%d, want 1", service.SideEffectFailureCount())
	}
}
