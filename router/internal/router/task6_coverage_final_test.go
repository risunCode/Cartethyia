package router

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"

	accounts "github.com/cartethyia/daemon/internal/accounts/auth"
	"github.com/cartethyia/daemon/internal/telemetry"
	"github.com/cartethyia/daemon/internal/telemetry/usage"
	contracts "github.com/cartethyia/daemon/internal/protocol"
	transforms "github.com/cartethyia/daemon/internal/protocol/codec"
	"github.com/cartethyia/daemon/internal/router/catalog"
)

type reconcileFailReservation struct{ err error }

func (r *reconcileFailReservation) Reconcile(context.Context, usage.Tokens) error { return r.err }
func (r *reconcileFailReservation) Release(context.Context, ReleaseReason) error {
	return nil
}

type finalReadinessRefresher struct{ err error }

func (f finalReadinessRefresher) Current(context.Context, string) (*accounts.TokenSet, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &accounts.TokenSet{}, nil
}

func TestRequestMetadataMessagesInputToolsAndOutcomes(t *testing.T) {
	meta := requestMetadata(contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat,
		Model:    "model",
		Headers:  http.Header{"X-Request-ID": []string{"md-1"}},
		Body:     []byte(`{"messages":[{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"x"}},{"type":"input_image"}]}],"tools":[{"type":"function"}]}`),
	})
	if meta.MessageCount != 1 || meta.ImageCount < 2 || meta.ToolCount != 1 {
		t.Fatalf("chat metadata=%+v", meta)
	}
	inputMeta := requestMetadata(contracts.Request{
		Protocol: contracts.ProtocolOpenAIResponse,
		Model:    "model",
		Body:     []byte(`{"input":[{"type":"message"},{"type":"input_image"},null]}`),
	})
	if inputMeta.MessageCount != 3 || inputMeta.ImageCount != 1 {
		t.Fatalf("input metadata=%+v", inputMeta)
	}
	applyResponseMetadata(nil, nil)
	applyResponseMetadata(&meta, []byte(`{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5,"input_tokens_details":{"cached_tokens":1},"cache_creation_input_tokens":2}}`))
	completeMetadata(nil, errors.New("x"), false, time.Now())
	completeMetadata(&meta, context.Canceled, true, time.Now())
	if meta.Outcome == "" || !meta.Cancelled {
		t.Fatalf("completeMetadata=%+v", meta)
	}
	_ = metadataOutcome(ErrClientDisconnect)
	_ = metadataOutcome(context.DeadlineExceeded)
	_ = metadataOutcome(errors.New("other"))
}

func TestStreamBridgeAbortAndCanonicalMapFallback(t *testing.T) {
	events := make(chan StreamEvent)
	stream := NewStream(events, nil, 0, 0)
	bridge := NewStreamBridge(stream, contracts.SurfaceOpenAIChat, "m")
	bridge.Abort(context.Canceled)
	bridge.Abort(errors.New("again"))
	_ = bridge.Close()

	events2 := make(chan StreamEvent)
	stream2 := NewStream(events2, nil, 0, 0)
	bridge2 := NewStreamBridge(stream2, contracts.SurfaceOpenAIChat, "m")
	bridge2.Abort(io.ErrShortWrite)
	_ = bridge2.Close()

	nilBridge := NewStreamBridge(nil, contracts.SurfaceOpenAIChat, "m")
	_ = nilBridge.Close()

	for _, payload := range []ProviderStreamPayload{
		{Data: []byte(`{"type":"message_start","id":"m1"}`)},
		{Data: []byte(`{"type":"text_delta","text":"hi"}`)},
		{Data: []byte(`{"type":"thinking_delta","text":"t"}`)},
		{Data: []byte(`{"type":"message_stop","id":"m1","reason":"stop"}`)},
		{Data: []byte(`{"type":"unknown.event"}`)},
		{Event: "usage", Data: []byte(`{"usage":{"prompt_tokens":1,"completion_tokens":1}}`)},
		{Data: []byte(`{"choices":[{"delta":{"reasoning_content":"r"},"finish_reason":"stop"}]}`)},
	} {
		_, _ = MapProviderPayload(payload)
	}
}

func TestDecorateFailureAndValidateRoutePlan(t *testing.T) {
	kinds := []FailureKind{
		FailureRateLimit, FailureQuota, FailureEntitlement, FailureCapacity, FailureEmptyOutput,
		FailureAuthentication, FailureReauthenticationRequired, FailureContentPolicy,
		FailureUnsupported, FailureTranslation, FailureInvalidRequest, FailureServerError,
		FailureTransient, FailureFatal, FailureAborted, FailureUnknown,
	}
	for _, kind := range kinds {
		f := Classify(ClassifyInput{Kind: kind, StatusCode: http.StatusForbidden, HeaderValues: []string{"Retry-After: 2"}})
		if f == nil || f.Kind != kind {
			t.Fatalf("kind=%s failure=%+v", kind, f)
		}
		_, _, _, _, _, _, _ = f.LifecycleEvidence()
		_ = f.CodeString()
		_ = f.Error()
		_ = kind.IsValid()
	}
	_ = FailureKind("nope").IsValid()
	_ = (*Failure)(nil).CodeString()
	_, _, _, _, _, _, _ = (*Failure)(nil).LifecycleEvidence()
	_ = (*Failure)(nil).Error()
	_ = Classify(ClassifyInput{Err: ErrAbort})
	_ = FromContracts(nil)

	req := contracts.Request{Protocol: contracts.SurfaceOpenAIChat}
	if err := validateRoutePlan(req, catalog.RoutePlan{}); err == nil {
		t.Fatal("empty members accepted")
	}
	if err := validateRoutePlan(req, catalog.RoutePlan{
		Strategy: "weird",
		Members:  []catalog.RouteMember{{ProviderID: "p", ClientModelID: "m", UpstreamModelID: "m", Surface: contracts.SurfaceOpenAIChat}},
	}); err == nil {
		t.Fatal("bad strategy accepted")
	}
	if err := validateRoutePlan(req, catalog.RoutePlan{
		Strategy: catalog.RouteStrategySingle,
		Members:  []catalog.RouteMember{{ProviderID: "", ClientModelID: "m", UpstreamModelID: "m", Surface: contracts.SurfaceOpenAIChat}},
	}); err == nil {
		t.Fatal("incomplete member accepted")
	}
	if err := validateRoutePlan(req, catalog.RoutePlan{
		Strategy: catalog.RouteStrategySingle,
		Members:  []catalog.RouteMember{{ProviderID: "p", ClientModelID: "m", UpstreamModelID: "m", Surface: contracts.SurfaceAnthropic}},
	}); err == nil {
		t.Fatal("surface mismatch accepted")
	}
}

func TestObserveRepairPreparationAndFailureKinds(t *testing.T) {
	registry := telemetry.NewRegistry()
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 1, Observer: registry})
	if err != nil {
		t.Fatal(err)
	}
	plan := fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat)
	req := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Headers: http.Header{"X-Request-ID": []string{"obs-1"}}}
	router.observePreparationExclusion(plan, 0, plan.Members[0])
	router.observeRepair(req, plan, 0, 1, RepairEvidence{Provider: "openai", RuleID: "rule", Changed: true}, true)
	router.observeRepair(req, plan, 0, 1, RepairEvidence{}, false)

	acct := Account{ID: "a", Provider: "openai"}
	for _, kind := range []FailureKind{
		FailureCapacity, FailureEmptyOutput, FailureTransient, FailureServerError, FailureRateLimit,
		FailureEntitlement, FailureReauthenticationRequired, FailureAuthentication, FailureQuota, FailureFatal,
	} {
		router.applyFailureForModel(&Failure{Kind: kind, Scope: contracts.RateScopeAccount, RateScope: contracts.RateScopeAccount}, &acct, "model")
		router.applyFailureForModel(&Failure{Kind: kind, Scope: contracts.RateScopeModel, RateScope: contracts.RateScopeModel}, &acct, "model")
	}
	router.applyFailureForModel(&Failure{Kind: FailureContentPolicy, Scope: contracts.RateScopeRoute}, &acct, "model")
	router.applyFailure(nil, &acct)
	(*Router)(nil).observePreparationExclusion(plan, 0, plan.Members[0])
	(*Router)(nil).observeRepair(req, plan, 0, 1, RepairEvidence{}, false)
}

func TestFinalizeHedgeLoserReconcileErrorsCatalogAndReadiness(t *testing.T) {
	router := &Router{}
	res := &reconcileFailReservation{err: errors.New("reconcile")}
	router.finalizeHedgeLoser(context.Background(), hedgeResult{
		candidate: &hedgeCandidate{reservation: res, account: Account{ID: "a"}},
		resp:      &contracts.Response{StatusCode: 200, Body: []byte(`{"usage":{"input_tokens":1,"output_tokens":1}}`)},
	})
	if router.QuotaPersistenceFailures() == 0 {
		t.Fatal("expected reconcile persistence failure")
	}
	router.finalizeHedgeLoser(context.Background(), hedgeResult{
		candidate: &hedgeCandidate{reservation: &reconcileFailReservation{err: errors.New("post")}, account: Account{ID: "a"}},
		err:       &contracts.RouteError{Kind: contracts.ErrorTransient, StatusCode: 503, Message: "tmp", Phase: contracts.RatePhaseProvider, RatePhase: contracts.RatePhaseProvider},
	})

	_ = (&DispatchService{Catalog: catalog.FixedResolver{Snapshot: &catalog.Snapshot{
		Generation: 1, Models: map[string]catalog.Model{}, Unqualified: map[string]string{}, Aliases: map[string]string{}, Combinations: map[string]catalog.Combination{},
	}}}).CatalogStatus()

	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{
		{ID: "ready", Provider: "openai", Enabled: true},
		{ID: "reauth", Provider: "openai", Enabled: true, ReauthRequired: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.StartProactiveRefresh(nil, nil, "openai", 0, 0); err == nil {
		t.Fatal("nil refresher accepted")
	}
	worker, err := pool.StartProactiveRefresh(nil, finalReadinessRefresher{err: errors.New("stale")}, "openai", 0, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	worker.Stop()
	(*ProactiveRefreshWorker)(nil).Stop()

	workerOK, err := pool.StartProactiveRefresh(context.Background(), finalReadinessRefresher{}, "openai", 1, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	workerOK.Stop()
}

func TestProjectionUnsupportedSourceAndSanitizeEdges(t *testing.T) {
	registry := transforms.NewDefaultRegistry()
	raw := &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":true}`)}
	if _, err := canonicalResponseProjection(contracts.Request{Protocol: contracts.Surface("bad")}, contracts.SurfaceOpenAIChat, raw, registry); err == nil {
		t.Fatal("bad source accepted")
	}
	if _, err := canonicalResponseProjection(contracts.Request{Protocol: contracts.SurfaceOpenAIChat}, "", raw, registry); err != nil {
		t.Fatalf("empty target should passthrough: %v", err)
	}
	if msg := SanitizeMessage(string([]byte{0xff, 0xfe, 'a', '\n'}), 10); msg == "" {
		t.Fatal("SanitizeMessage empty")
	}
	_ = extractStringField([]byte(`{"model"`), "model")
	_ = extractStringField([]byte(`{"model":}`), "model")
	_ = bytesIndex([]byte("abc"), []byte("z"))
	_ = skipWhitespace([]byte(" \t\nx"))
	_ = countImageOccurrences([]byte(`{"image":1}`), 10)
}
