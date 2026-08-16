package proxy

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/observability/usage"
	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy/control/continuation"
	"github.com/cartethyia/daemon/internal/proxy/control/tokenbudget"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
	"github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
)

type coverageQuotaAuthority struct {
	reserves atomic.Int32
	fail     error
}

type coverageQuotaReservation struct {
	reconciles atomic.Int32
	releases   atomic.Int32
	releaseErr error
}

func (a *coverageQuotaAuthority) Reserve(_ context.Context, req tokenbudget.ReservationRequest) (tokenbudget.TokenReservation, error) {
	a.reserves.Add(1)
	if a.fail != nil {
		return nil, a.fail
	}
	if err := req.Validate(); err != nil {
		return nil, err
	}
	return &coverageQuotaReservation{}, nil
}

func (r *coverageQuotaReservation) Reconcile(context.Context, usage.Tokens) error {
	r.reconciles.Add(1)
	return nil
}

func (r *coverageQuotaReservation) Release(context.Context, tokenbudget.ReleaseReason) error {
	r.releases.Add(1)
	return r.releaseErr
}

type coveragePreparer struct {
	closes atomic.Int32
	fail   bool
}

func (p *coveragePreparer) Prepare(_ context.Context, account Account, request contracts.Request) (*PreparedAttempt, error) {
	if p.fail {
		return nil, errors.New("prepare failed")
	}
	return NewPreparedAttempt(account, request, func() error {
		p.closes.Add(1)
		return nil
	})
}

type coverageStreamTransport struct{}

func (coverageStreamTransport) CallStream(context.Context, Account, contracts.Request) (*Stream, error) {
	events := make(chan StreamEvent, 2)
	events <- StreamEvent{Kind: EventTextDelta, Text: "hi"}
	events <- StreamEvent{Kind: EventMessageStop, Reason: "completed"}
	close(events)
	return NewStream(events, nil, 0, 0), nil
}

type delayedHedgeTransport struct {
	firstGate  chan struct{}
	secondGate chan struct{}
	calls      atomic.Int32
	failFirst  bool
	failSecond bool
}

func (t *delayedHedgeTransport) Call(ctx context.Context, acct Account, _ contracts.Request) (*contracts.Response, error) {
	n := t.calls.Add(1)
	if n == 1 {
		if t.firstGate != nil {
			select {
			case <-t.firstGate:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if t.failFirst {
			return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, StatusCode: 503, Message: "first failed", Retryable: true, AlternateAccountEligible: true}
		}
		return &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":"first"}`)}, nil
	}
	if t.secondGate != nil {
		select {
		case <-t.secondGate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if t.failSecond {
		return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, StatusCode: 503, Message: "second failed", Retryable: true, AlternateAccountEligible: true}
	}
	return &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":"second"}`)}, nil
}

type failingCatalog struct{ err error }

func (f failingCatalog) Current(context.Context) (*catalog.Snapshot, catalog.RefreshStatus, error) {
	return nil, catalog.RefreshStatus{}, f.err
}

type statusCatalog struct {
	snap   *catalog.Snapshot
	status catalog.RefreshStatus
}

func (s statusCatalog) Current(context.Context) (*catalog.Snapshot, catalog.RefreshStatus, error) {
	return s.snap.Clone(), s.status, nil
}

func (s statusCatalog) Status() catalog.RefreshStatus { return s.status }

func TestExecuteHedgeSecondWinsAndFirstIsFinalized(t *testing.T) {
	router, _ := newHedgeRouter(t, func(context.Context, time.Duration) bool { return true })
	transport := &delayedHedgeTransport{
		firstGate:  make(chan struct{}),
		secondGate: make(chan struct{}),
		failFirst:  true,
	}
	close(transport.secondGate)
	go func() {
		time.Sleep(20 * time.Millisecond)
		close(transport.firstGate)
	}()
	req := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}
	response, _, err := router.Route(context.Background(), transport, req, hedgeEligiblePlan())
	if err != nil {
		t.Fatalf("route: %v", err)
	}
	if response == nil || !bytes.Contains(response.Body, []byte(`"second"`)) {
		t.Fatalf("response=%+v", response)
	}
	if transport.calls.Load() < 2 {
		t.Fatalf("calls=%d", transport.calls.Load())
	}
}

func TestExecuteHedgeBothFailReturnsFirstFailure(t *testing.T) {
	router, _ := newHedgeRouter(t, func(context.Context, time.Duration) bool { return true })
	transport := &delayedHedgeTransport{failFirst: true, failSecond: true}
	req := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}
	response, failure, err := router.Route(context.Background(), transport, req, hedgeEligiblePlan())
	if err != nil {
		t.Fatalf("route: %v", err)
	}
	if response != nil {
		t.Fatalf("unexpected response %+v", response)
	}
	if failure == nil {
		t.Fatal("expected failure")
	}
	if transport.calls.Load() < 2 {
		t.Fatalf("calls=%d", transport.calls.Load())
	}
}

func TestExecuteHedgeDiscardsPreparedAlternateWhenPrimaryFinishesEarly(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{
		{ID: "a", Provider: "openai", Enabled: true},
		{ID: "b", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	preparer := &coveragePreparer{}
	router, err := NewRouter(RouterConfig{
		Pool: pool, MaxAttempts: 3, HedgeEnabled: true, HedgeDelay: time.Millisecond,
		Preparer: preparer,
		Wait:     func(context.Context, time.Duration) bool { return true },
	})
	if err != nil {
		t.Fatal(err)
	}
	transport := &delayedHedgeTransport{}
	req := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}
	response, _, routeErr := router.Route(context.Background(), transport, req, hedgeEligiblePlan())
	if routeErr != nil || response == nil {
		t.Fatalf("response=%+v err=%v", response, routeErr)
	}
	if preparer.closes.Load() == 0 {
		t.Fatal("prepared attempt was never closed")
	}
}

func TestReserveAttemptUsesTokenBudgetAuthority(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{
		{ID: "a", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 1, DefaultOutputCap: 16})
	if err != nil {
		t.Fatal(err)
	}
	authority := &coverageQuotaAuthority{}
	ctx := tokenbudget.WithAuthority(context.Background(), authority, tokenbudget.Identity{
		KeyID: "key-1", RequestID: "req-1", WindowUTC: time.Now().UTC().Truncate(time.Hour),
	})
	req := contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat, Model: "model",
		Body: []byte(`{"messages":[{"role":"user","content":"hi"}],"max_tokens":8}`),
	}
	response, failure, routeErr := router.Route(ctx, &hedgeTestTransport{}, req, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
	if routeErr != nil || failure != nil || response == nil {
		t.Fatalf("response=%+v failure=%+v err=%v", response, failure, routeErr)
	}
	if authority.reserves.Load() != 1 {
		t.Fatalf("reserves=%d", authority.reserves.Load())
	}
}

func TestReserveAttemptRejectsInvalidEstimate(t *testing.T) {
	router := &Router{defaultOutputCap: tokenbudget.MaxTokenCount}
	authority := &coverageQuotaAuthority{}
	ctx := tokenbudget.WithAuthority(context.Background(), authority, tokenbudget.Identity{
		KeyID: "key-1", RequestID: "req-1", WindowUTC: time.Now().UTC().Truncate(time.Hour),
	})
	huge := contracts.Request{Body: bytes.Repeat([]byte("x"), 64)}
	if _, err := router.reserveAttempt(ctx, huge, 1); !errors.Is(err, tokenbudget.ErrInvalid) {
		t.Fatalf("reserveAttempt err=%v", err)
	}
}

func TestAttachPreparedAttemptTransfersCloser(t *testing.T) {
	events := make(chan StreamEvent, 1)
	events <- StreamEvent{Kind: EventMessageStop, Reason: "completed"}
	close(events)
	stream := NewStream(events, nil, 0, 0)
	closed := atomic.Bool{}
	attempt, err := NewPreparedAttempt(
		Account{ID: "a", Provider: "openai"},
		contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model"},
		func() error { closed.Store(true); return nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	stream.AttachPreparedAttempt(nil)
	stream.AttachPreparedAttempt(attempt)
	if _, err := stream.Next(context.Background()); err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("Next: %v", err)
	}
	_ = stream.Close()
	if !closed.Load() {
		t.Fatal("prepared closer was not invoked")
	}

	late := atomic.Bool{}
	lateAttempt, err := NewPreparedAttempt(
		Account{ID: "b", Provider: "openai"},
		contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model"},
		func() error { late.Store(true); return nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	stream.AttachPreparedAttempt(lateAttempt)
	if !late.Load() {
		t.Fatal("attach on closed stream must close immediately")
	}
}

func TestRouteStreamAttachesPreparedAttempt(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{
		{ID: "a", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	preparer := &coveragePreparer{}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 1, Preparer: preparer})
	if err != nil {
		t.Fatal(err)
	}
	stream, _, failure, routeErr := router.RouteStream(
		context.Background(),
		coverageStreamTransport{},
		contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Stream: true, Body: []byte(`{}`)},
		fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat),
	)
	if routeErr != nil || failure != nil || stream == nil {
		t.Fatalf("stream=%v failure=%v err=%v", stream, failure, routeErr)
	}
	_ = stream.Close()
	if preparer.closes.Load() == 0 {
		t.Fatal("prepared attempt was not closed through stream")
	}
}

func TestResolveCatalogNilAmbiguousAndFailures(t *testing.T) {
	service := &DispatchService{}
	plan, err := service.resolveCatalog(context.Background(), &contracts.Request{Model: "model", Protocol: contracts.SurfaceOpenAIChat})
	if err != nil {
		t.Fatalf("nil catalog: %v", err)
	}
	if plan.Strategy != catalog.RouteStrategySingle || len(plan.Members) != 1 || plan.Members[0].ProviderID != "openai" {
		t.Fatalf("default plan=%+v", plan)
	}

	_, err = (&DispatchService{Catalog: failingCatalog{err: errors.New("catalog down")}}).resolveCatalog(context.Background(), &contracts.Request{Model: "model", Protocol: contracts.SurfaceOpenAIChat})
	if err == nil || DispatchCodeOf(err) != codeDispatchCatalog {
		t.Fatalf("unavailable catalog err=%v code=%q", err, DispatchCodeOf(err))
	}

	snap := &catalog.Snapshot{
		Generation:  7,
		Models:      map[string]catalog.Model{},
		Unqualified: map[string]string{},
		Aliases:     map[string]string{},
		Combinations: map[string]catalog.Combination{},
	}
	_, err = (&DispatchService{Catalog: catalog.FixedResolver{Snapshot: snap}}).resolveCatalog(context.Background(), &contracts.Request{Model: "missing", Protocol: contracts.SurfaceOpenAIChat})
	if err == nil || DispatchCodeOf(err) != codeDispatchCatalog {
		t.Fatalf("unknown model err=%v", err)
	}

	ambiguous := &catalog.Snapshot{
		Generation: 3,
		Models: map[string]catalog.Model{
			"openai:model": {
				ID: "model", QualifiedID: "openai:model", ProviderID: "openai", UpstreamID: "model",
				Surfaces:     []providers.Surface{providers.SurfaceOpenAIChat},
				Capabilities: providers.ProviderCaps{Surfaces: []providers.Surface{providers.SurfaceOpenAIChat}, Streaming: true},
			},
		},
		Unqualified:  map[string]string{"model": ""},
		Aliases:      map[string]string{},
		Combinations: map[string]catalog.Combination{},
	}
	plan, err = (&DispatchService{Catalog: catalog.FixedResolver{Snapshot: ambiguous}}).resolveCatalog(context.Background(), &contracts.Request{Model: "model", Protocol: contracts.SurfaceOpenAIChat})
	if err != nil {
		t.Fatalf("ambiguous fallback: %v", err)
	}
	if plan.RequestedModel != "model" || len(plan.Members) != 1 || plan.Members[0].ProviderID != "openai" {
		t.Fatalf("ambiguous plan=%+v", plan)
	}

	status := (&DispatchService{Catalog: statusCatalog{snap: ambiguous, status: catalog.RefreshStatus{Generation: 3, Diagnostic: "ok"}}}).CatalogStatus()
	if status.Generation != 3 || status.Diagnostic != "ok" {
		t.Fatalf("CatalogStatus=%+v", status)
	}
	if got := (*DispatchService)(nil).CatalogStatus(); got != (catalog.RefreshStatus{}) {
		t.Fatalf("nil CatalogStatus=%+v", got)
	}
}

func TestValidateContinuationRejectsUnknownBinding(t *testing.T) {
	store := continuation.New(time.Hour)
	t.Cleanup(func() { _ = store.Close(context.Background()) })
	if err := store.Put(context.Background(), continuation.State{
		ID: "resp_known", ResponseID: "resp_known", Scope: "scope-a", Provider: "openai", Model: "model",
	}); err != nil {
		t.Fatal(err)
	}
	service := &DispatchService{Continuations: store}

	if err := service.validateContinuation(context.Background(), contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat, Body: []byte(`{"previous_response_id":"resp_known"}`),
	}); err != nil {
		t.Fatalf("non-responses protocol should skip: %v", err)
	}
	if err := service.validateContinuation(context.Background(), contracts.Request{
		Protocol: contracts.ProtocolOpenAIResponse, Body: []byte(`{"input":[]}`),
	}); err != nil {
		t.Fatalf("missing previous id should skip: %v", err)
	}
	if err := service.validateContinuation(context.Background(), contracts.Request{
		Protocol: contracts.ProtocolOpenAIResponse, Body: []byte(`{`),
	}); err == nil || DispatchCodeOf(err) != codeDispatchInvalidRequest {
		t.Fatalf("invalid json err=%v", err)
	}
	if err := service.validateContinuation(context.Background(), contracts.Request{
		Protocol: contracts.ProtocolOpenAIResponse, Model: "model",
		Body: []byte(`{"previous_response_id":"resp_known"}`),
	}); err == nil || DispatchCodeOf(err) != codeDispatchInvalidRequest {
		t.Fatalf("missing scope err=%v", err)
	}
	if err := service.validateContinuation(context.Background(), contracts.Request{
		Protocol: contracts.ProtocolOpenAIResponse, Model: "model", ContinuationScope: "scope-a",
		Body: []byte(`{"previous_response_id":"resp_missing"}`),
	}); err == nil || DispatchCodeOf(err) != codeDispatchInvalidRequest {
		t.Fatalf("missing continuation err=%v", err)
	}
	if err := service.validateContinuation(context.Background(), contracts.Request{
		Protocol: contracts.ProtocolOpenAIResponse, Model: "model", ContinuationScope: "scope-a",
		Body: []byte(`{"previous_response_id":"resp_known"}`),
	}); err != nil {
		t.Fatalf("valid continuation rejected: %v", err)
	}
}

func TestHandleFailureAndModelScopedMarks(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{
		{ID: "a", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	lease, _, err := pool.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model", Surface: contracts.SurfaceOpenAIChat})
	if err != nil {
		t.Fatal(err)
	}
	acct := lease.Account
	lease.Release()

	failure := router.handleFailure(&contracts.RouteError{
		Kind: contracts.ErrorTransient, StatusCode: 503, Retryable: true,
		RateScope: contracts.RateScopeAccount, Scope: contracts.RateScopeAccount,
	}, &acct, 1)
	if failure == nil || failure.Kind != FailureTransient {
		t.Fatalf("failure=%+v", failure)
	}
	state, snap := pool.Snapshot(acct.ID)
	if state != StateCoolingDown || snap == nil {
		t.Fatalf("state=%s snap=%+v", state, snap)
	}

	router.applyFailureForModel(&Failure{Kind: FailureQuota, Scope: contracts.RateScopeModel, RateScope: contracts.RateScopeModel}, &acct, "model")
	router.applyFailureForModel(&Failure{Kind: FailureAuthentication, Scope: contracts.RateScopeModel, RateScope: contracts.RateScopeModel}, &acct, "model")
	router.applyFailureForModel(&Failure{Kind: FailureFatal, Scope: contracts.RateScopeModel, RateScope: contracts.RateScopeModel}, &acct, "model")
	pool.MarkExhaustedForModel(acct.ID, "model-b")
	pool.MarkErrorForModel(acct.ID, "model-c")
	pool.MarkAuthenticationForModel(acct.ID, "model-d")
}

func TestWaitWithTimerAndPipeWithDisconnect(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if waitWithTimer(ctx, 50*time.Millisecond) {
		t.Fatal("canceled wait should return false")
	}
	if !waitWithTimer(context.Background(), time.Millisecond) {
		t.Fatal("short wait should return true")
	}

	src := strings.NewReader("payload")
	var dst bytes.Buffer
	if err := PipeWithDisconnect(context.Background(), src, &dst); err != nil {
		t.Fatalf("PipeWithDisconnect: %v", err)
	}
	if dst.String() != "payload" {
		t.Fatalf("dst=%q", dst.String())
	}
	if err := PipeWithDisconnect(context.Background(), nil, &dst); StreamCodeOf(err) != StreamCodeMalformedEvent {
		t.Fatalf("nil src err=%v", err)
	}
	if err := PipeWithDisconnect(context.Background(), src, nil); StreamCodeOf(err) != StreamCodeWriteFailure {
		t.Fatalf("nil dst err=%v", err)
	}
	canceled, cancelPipe := context.WithCancel(context.Background())
	cancelPipe()
	if err := PipeWithDisconnect(canceled, strings.NewReader("x"), &bytes.Buffer{}); StreamCodeOf(err) != StreamCodeClientDisconnect {
		t.Fatalf("canceled pipe err=%v", err)
	}
}

func TestRendezvousSelectorOrdersDeterministically(t *testing.T) {
	selector := NewRendezvousSelector()
	if (AffinityKey{Namespace: "ns", Value: "v"}).String() != "ns:v" {
		t.Fatal("affinity string")
	}
	if _, _, err := selector.Select(context.Background(), nil, AffinityKey{}); !errors.Is(err, ErrNoCandidate) {
		t.Fatalf("empty select err=%v", err)
	}
	first, decision, err := selector.Select(context.Background(), []ProviderCandidate{
		{ID: "b", Priority: 1},
		{ID: "a", Priority: 1, StickyAffinity: true},
		{ID: "c", Priority: 1},
	}, AffinityKey{Namespace: "user", Value: "42"})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := selector.Select(context.Background(), []ProviderCandidate{
		{ID: "c", Priority: 1},
		{ID: "a", Priority: 1, StickyAffinity: true},
		{ID: "b", Priority: 1},
	}, AffinityKey{Namespace: "user", Value: "42"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Fatalf("non-deterministic selection %q vs %q", first.ID, second.ID)
	}
	if decision.CandidateID == "" || decision.AffinityKey != "user:42" {
		t.Fatalf("decision=%+v", decision)
	}
}

func TestStreamBridgeCodecGenericAnthropicAndUsageHelpers(t *testing.T) {
	events := make(chan StreamEvent, 8)
	events <- StreamEvent{Kind: EventThinkingDelta, Text: "think"}
	events <- StreamEvent{Kind: EventTextDelta, Text: "hello"}
	events <- StreamEvent{Kind: EventToolCallStart, CallID: "call_1", CallName: "tool"}
	events <- StreamEvent{Kind: EventToolCallDelta, CallID: "call_1", Text: `{"a":1}`}
	events <- StreamEvent{Kind: EventToolCallEnd, CallID: "call_1"}
	events <- StreamEvent{Kind: EventServerToolResult, Payload: []byte(`{"ok":true}`)}
	events <- StreamEvent{Kind: EventUsage, Usage: &StreamUsage{InputTokens: 1, OutputTokens: 2, CacheReadTokens: 3, CacheWriteTokens: 4}}
	events <- StreamEvent{Kind: EventMessageStop, Reason: "tool_call"}
	close(events)
	anthropicBody, err := readBridge(t, NewStreamBridge(NewStream(events, nil, 0, 0), contracts.SurfaceAnthropic, "claude"))
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("anthropic bridge: %v", err)
	}
	if !strings.Contains(anthropicBody, "thinking_delta") || !strings.Contains(anthropicBody, "tool_use") {
		t.Fatalf("anthropic body=%s", anthropicBody)
	}

	genericEvents := make(chan StreamEvent, 2)
	genericEvents <- StreamEvent{Kind: EventTextDelta, Text: "g"}
	genericEvents <- StreamEvent{Kind: EventMessageStop, Reason: "completed"}
	close(genericEvents)
	genericBody, err := readBridge(t, NewStreamBridge(NewStream(genericEvents, nil, 0, 0), contracts.SurfaceGemini, "gem"))
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("generic bridge: %v", err)
	}
	if !strings.Contains(genericBody, `"type":"text.delta"`) && !strings.Contains(genericBody, string(EventTextDelta)) {
		t.Fatalf("generic body=%s", genericBody)
	}

	codecEvents := make(chan StreamEvent, 2)
	codecEvents <- StreamEvent{Kind: EventTextDelta, Text: "codec"}
	codecEvents <- StreamEvent{Kind: EventMessageStop, Reason: "length"}
	close(codecEvents)
	bridge := NewCodecStreamBridge(NewStream(codecEvents, nil, 0, 0), contracts.SurfaceOpenAIChat, "gpt", transforms.NewDefaultRegistry())
	codecBody, err := readBridge(t, bridge)
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("codec bridge: %v", err)
	}
	if codecBody == "" {
		t.Fatal("codec bridge produced empty body")
	}
	_ = bridge.Close()

	if usageObject(nil)["prompt_tokens"] != 0 {
		t.Fatal("nil usageObject")
	}
	if usageObject(&StreamUsage{InputTokens: 2, OutputTokens: 3})["total_tokens"] != 5 {
		t.Fatal("usageObject total")
	}
	if len(anthropicUsage(nil)) != 0 {
		t.Fatal("nil anthropicUsage")
	}
	if anthropicUsage(&StreamUsage{InputTokens: 9})["input_tokens"] != 9 {
		t.Fatal("anthropicUsage")
	}
	for _, reason := range []string{"length", "tool_call", "content_filter", "compaction", "pause_turn", "other"} {
		if anthropicStop(reason) == "" {
			t.Fatalf("anthropicStop(%q)", reason)
		}
	}
	normalized := NormalizedStreamEvent(StreamEvent{Kind: EventCompactionItem, Text: "c", Usage: &StreamUsage{InputTokens: 1}})
	if normalized.Type == "" || normalized.Usage == nil {
		t.Fatalf("normalized=%+v", normalized)
	}
	terminal := NormalizedStreamEvent(StreamEvent{Kind: EventMessageStop, Reason: "error", Err: errors.New("x")})
	if terminal.StopReason == nil {
		t.Fatalf("terminal normalized=%+v", terminal)
	}
	if CodeOf(streamError(StreamCodeIdleTimeout, "idle", ErrStreamStall)) != StreamCodeIdleTimeout {
		t.Fatal("CodeOf")
	}
	if ReadinessReady.String() == "" {
		t.Fatal("Readiness.String")
	}
}

func TestDiscardHedgeCandidateAndQuotaPersistence(t *testing.T) {
	router := &Router{}
	router.discardHedgeCandidate(context.Background(), nil)
	reservation := &coverageQuotaReservation{releaseErr: errors.New("persist")}
	closed := false
	attempt, err := NewPreparedAttempt(Account{ID: "a"}, contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "m"}, func() error {
		closed = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	lease, _, err := pool.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "m", Surface: contracts.SurfaceOpenAIChat})
	if err != nil {
		t.Fatal(err)
	}
	router.discardHedgeCandidate(context.Background(), &hedgeCandidate{prepared: attempt, reservation: reservation, lease: lease})
	if !closed || reservation.releases.Load() != 1 {
		t.Fatalf("closed=%v releases=%d", closed, reservation.releases.Load())
	}
	if router.QuotaPersistenceFailures() != 1 {
		t.Fatalf("quota failures=%d", router.QuotaPersistenceFailures())
	}
	if (*Router)(nil).QuotaPersistenceFailures() != 0 {
		t.Fatal("nil QuotaPersistenceFailures")
	}
}

func TestHedgeJSONHelpersAndOperationLabel(t *testing.T) {
	if !hedgeAnyPresent("x") || hedgeAnyPresent("") || hedgeAnyPresent("none") {
		t.Fatal("hedgeAnyPresent strings")
	}
	if !hedgeAnyPresent([]any{1}) || hedgeAnyPresent([]any{}) {
		t.Fatal("hedgeAnyPresent slices")
	}
	if !hedgeAnyPresent(map[string]any{"a": 1}) || hedgeAnyPresent(map[string]any{}) {
		t.Fatal("hedgeAnyPresent maps")
	}
	if !hedgeAnyPresent(true) || hedgeAnyPresent(false) || !hedgeAnyPresent(3) {
		t.Fatal("hedgeAnyPresent scalars")
	}
	if !hedgeJSONValuePresent([]byte(`"x"`)) || hedgeJSONValuePresent([]byte(`null`)) || hedgeJSONValuePresent([]byte(`{`)) {
		t.Fatal("hedgeJSONValuePresent")
	}
	if operationLabel(transforms.OperationGenerate) == "" || operationLabel(transforms.OperationCompactV1) == "" {
		t.Fatal("operationLabel")
	}
	if DispatchCodeOf(nil) != "" {
		t.Fatal("DispatchCodeOf nil")
	}
	if modelFromBody([]byte(`{"model":"m"}`)) != "m" {
		t.Fatal("modelFromBody")
	}
}
