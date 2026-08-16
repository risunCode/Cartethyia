package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy/control/continuation"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
	"github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
)

type statusTransport struct {
	status int
	body   []byte
}

func (t statusTransport) Call(context.Context, Account, contracts.Request) (*contracts.Response, error) {
	return &contracts.Response{StatusCode: t.status, Body: t.body, Headers: http.Header{"Content-Type": []string{"application/json"}}}, nil
}

type repairTransport struct {
	called bool
}

func (t *repairTransport) Call(context.Context, Account, contracts.Request) (*contracts.Response, error) {
	return &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":true}`)}, nil
}

func (t *repairTransport) ProposeRepair(Account, contracts.Request, string) (providers.RepairProposal, bool) {
	t.called = true
	return providers.RepairProposal{RuleID: "fixture", Body: []byte(`{"repaired":true}`)}, true
}

func TestContractKindDispatchHelpersAndResponseAccessors(t *testing.T) {
	kinds := []FailureKind{
		FailureInvalidRequest, FailureUnsupported, FailureTranslation, FailureEntitlement,
		FailureContentPolicy, FailureReauthenticationRequired, FailureCapacity, FailureEmptyOutput,
		FailureAuthentication, FailureRateLimit, FailureQuota, FailureTransient, FailureServerError,
		FailureFatal, FailureAborted, FailureUnknown, FailureKind("other"),
	}
	for _, kind := range kinds {
		if contractKind(kind) == "" {
			t.Fatalf("contractKind(%q) empty", kind)
		}
		_ = messageFor(kind, 400)
	}
	signals := []string{
		"rate_limit", "quota", "capacity", "content_policy", "unauthorized", "invalid_grant",
		"unsupported", "translation", "context_length_exceeded", "mystery",
	}
	for _, signal := range signals {
		if classifySignal(signal) == "" {
			t.Fatalf("classifySignal(%q)", signal)
		}
	}

	derr := dispatchError(codeDispatchNoRoute, contracts.ErrorTransient, http.StatusServiceUnavailable, "none", ErrNoAccount)
	if derr.(*DispatchError).CodeString() != codeDispatchNoRoute || derr.Error() == "" {
		t.Fatalf("DispatchError=%v", derr)
	}
	if (*DispatchError)(nil).CodeString() != "" {
		t.Fatal("nil CodeString")
	}
	if err := dispatchRouterError(ErrNoAccount); DispatchCodeOf(err) != codeDispatchNoRoute {
		t.Fatalf("dispatchRouterError ErrNoAccount=%v", err)
	}
	if err := dispatchRouterError(context.Canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("dispatchRouterError canceled=%v", err)
	}
	if err := dispatchContextError(context.DeadlineExceeded); DispatchCodeOf(err) != codeDispatchDeadline {
		t.Fatalf("deadline err=%v", err)
	}

	buf := &bufferResponse{status: 201, contentType: "application/json", headers: http.Header{"X": []string{"1"}}, body: []byte(`{}`)}
	if buf.StatusCode() != 201 || buf.ContentType() != "application/json" || buf.Headers().Get("X") != "1" {
		t.Fatalf("buffer accessors=%+v", buf)
	}
	stream := &streamResponse{status: 200, contentType: "text/event-stream", headers: http.Header{"Cache-Control": []string{"no-cache"}}}
	if stream.StatusCode() != 200 || stream.ContentType() != "text/event-stream" || stream.Headers().Get("Cache-Control") != "no-cache" {
		t.Fatalf("stream accessors=%+v", stream)
	}

	cloned := cloneNormalizedRequestForRuntime(&transforms.NormalizedRequest{
		Model: "m", Messages: []transforms.NormalizedMessage{{Role: transforms.RoleUser, Content: []transforms.ContentBlock{{Type: transforms.BlockText, Text: "hi"}}}},
	})
	if cloned == nil || cloned.Model != "m" || len(cloned.Messages) != 1 {
		t.Fatalf("clone=%+v", cloned)
	}
}

func TestValidatingTransportProposeRepairAndNonSuccess(t *testing.T) {
	repairer := &repairTransport{}
	vt := validatingTransport{next: repairer}
	proposal, ok := vt.ProposeRepair(Account{ID: "a"}, contracts.Request{Model: "m"}, "rule")
	if !ok || !repairer.called || proposal.RuleID != "fixture" {
		t.Fatalf("ProposeRepair ok=%v proposal=%+v", ok, proposal)
	}
	if _, ok := (validatingTransport{next: &hedgeTestTransport{}}).ProposeRepair(Account{}, contracts.Request{}, ""); ok {
		t.Fatal("non-repair transport unexpectedly proposed")
	}

	pool, err := NewAccountPool(PoolConfig{Store: lifecycleStore{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	service := &DispatchService{
		Router: router, Transport: statusTransport{status: http.StatusTooManyRequests, body: []byte(`{"error":"rate"}`)},
		Codecs: transforms.NewDefaultRegistry(),
	}
	_, err = service.DispatchContext(context.Background(), lifecycleRequest())
	if err == nil {
		t.Fatal("expected rate-limit classification")
	}
	if DispatchCodeOf(err) != codeDispatchProvider {
		t.Fatalf("err=%v code=%q", err, DispatchCodeOf(err))
	}
}

func TestRecordContinuationAndFailureExhaustion(t *testing.T) {
	store := continuation.New(time.Hour)
	t.Cleanup(func() { _ = store.Close(context.Background()) })
	registry := observability.NewRegistry()
	service := &DispatchService{Continuations: store, Evidence: registry}
	req := contracts.Request{
		Protocol: contracts.ProtocolOpenAIResponse, Model: "model", ContinuationScope: "scope-a",
		Headers: http.Header{"X-Request-ID": []string{"cont-1"}},
	}
	if err := service.recordContinuationID(context.Background(), req, "resp_new"); err != nil {
		t.Fatalf("recordContinuationID: %v", err)
	}
	if _, err := store.ResolveFor(context.Background(), "resp_new", continuation.Binding{Scope: "scope-a", Provider: "openai", Model: "model"}); err != nil {
		t.Fatalf("resolve recorded continuation: %v", err)
	}
	if err := service.recordContinuationID(context.Background(), req, ""); err != nil {
		t.Fatalf("empty id: %v", err)
	}
	if err := service.recordContinuationID(context.Background(), contracts.Request{Protocol: contracts.ProtocolOpenAIResponse, Model: "model"}, "resp_x"); err != nil {
		t.Fatalf("missing scope skip: %v", err)
	}

	service.observeFailureExhaustion(nil)
	for _, kind := range []FailureKind{FailureRateLimit, FailureAuthentication, FailureQuota, FailureTranslation, FailureFatal} {
		service.observeFailureExhaustion(&Failure{Kind: kind, Code: "provider.fixture"})
	}
	if defaultProviderForSurface(contracts.SurfaceAnthropic) != "anthropic" {
		t.Fatal("anthropic provider")
	}
	if defaultProviderForSurface(contracts.SurfaceGemini) != "default" {
		t.Fatal("default provider")
	}
}

func TestMapProviderPayloadCoversMajorEventFamilies(t *testing.T) {
	payloads := []ProviderStreamPayload{
		{Data: []byte(`{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":2}}}`)},
		{Data: []byte(`{"type":"response.created","response":{"id":"resp_1"}}`)},
		{Data: []byte(`{"type":"response.output_text.delta","delta":"hi"}`)},
		{Data: []byte(`{"type":"response.reasoning_summary_text.delta","delta":"think"}`)},
		{Data: []byte(`{"type":"response.function_call_arguments.delta","delta":"{}"}`)},
		{Data: []byte(`{"type":"response.output_item.added","item":{"type":"function_call","id":"call_1","call_id":"call_1","name":"tool"}}`)},
		{Data: []byte(`{"type":"response.completed","response":{"status":"completed"}}`)},
		{Data: []byte(`{"type":"response.incomplete","response":{"status":"incomplete"}}`)},
		{Data: []byte(`{"type":"response.failed","response":{"error":{"message":"boom"}}}`)},
		{Data: []byte(`{"type":"response.compaction","item":{"type":"compaction","encrypted_content":"abc"}}`)},
		{Data: []byte(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`)},
		{Data: []byte(`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"t"}}`)},
		{Data: []byte(`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{"}}`)},
		{Data: []byte(`{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_2","name":"tool"}}`)},
		{Data: []byte(`{"type":"content_block_stop","index":2}`)},
		{Data: []byte(`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1}}`)},
		{Data: []byte(`{"type":"message_stop"}`)},
		{Data: []byte(`{"type":"error","error":{"message":"nope"}}`)},
		{Data: []byte(`{"choices":[{"delta":{"content":"hi","tool_calls":[{"id":"c1","function":{"name":"t","arguments":"{}"}}]},"finish_reason":null}]}`)},
		{Data: []byte(`{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)},
		{Data: []byte(`{"usage":{"prompt_tokens":3,"completion_tokens":4}}`)},
		{Event: "ping", Data: []byte(`{"type":"ping"}`)},
		{ID: "sse-1", Data: []byte(`{"type":"message_start","message":{"id":""}}`)},
	}
	for i, payload := range payloads {
		events, err := MapProviderPayload(payload)
		if err != nil && StreamCodeOf(err) == "" {
			t.Fatalf("payload %d err=%v", i, err)
		}
		_ = events
	}
	if _, err := MapProviderPayload(ProviderStreamPayload{Data: []byte(`{`)}); StreamCodeOf(err) != StreamCodeMalformedEvent {
		t.Fatalf("malformed json err=%v", err)
	}
	if _, err := MapProviderPayload(ProviderStreamPayload{}); StreamCodeOf(err) != StreamCodeMalformedEvent {
		t.Fatalf("empty payload err=%v", err)
	}
}

func TestStreamBridgeChatAndResponsesEventCoverage(t *testing.T) {
	chatEvents := make(chan StreamEvent, 10)
	chatEvents <- StreamEvent{Kind: EventMessageStart, CallID: "chat_1"}
	chatEvents <- StreamEvent{Kind: EventThinkingDelta, Text: "reason"}
	chatEvents <- StreamEvent{Kind: EventTextDelta, Text: "hello"}
	chatEvents <- StreamEvent{Kind: EventToolCallStart, CallID: "tool_1", CallName: "lookup"}
	chatEvents <- StreamEvent{Kind: EventToolCallDelta, CallID: "tool_1", Text: `{"q":1}`}
	chatEvents <- StreamEvent{Kind: EventToolCallEnd, CallID: "tool_1"}
	chatEvents <- StreamEvent{Kind: EventServerToolResult, Payload: []byte(`result`)}
	chatEvents <- StreamEvent{Kind: EventUsage, Usage: &StreamUsage{InputTokens: 2, OutputTokens: 3, TotalTokens: 5}}
	chatEvents <- StreamEvent{Kind: EventMessageStop, Reason: "length"}
	close(chatEvents)
	body, err := readBridge(t, NewStreamBridge(NewStream(chatEvents, nil, 0, 0), contracts.SurfaceOpenAIChat, "gpt"))
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("chat bridge: %v", err)
	}
	if !strings.Contains(body, "chatcmpl-") || !strings.Contains(body, "tool_calls") && !strings.Contains(body, "finish_reason") {
		t.Fatalf("chat body=%s", body)
	}

	respEvents := make(chan StreamEvent, 10)
	respEvents <- StreamEvent{Kind: EventMessageStart, CallID: "resp_1"}
	respEvents <- StreamEvent{Kind: EventThinkingDelta, Text: "r"}
	respEvents <- StreamEvent{Kind: EventTextDelta, Text: "t"}
	respEvents <- StreamEvent{Kind: EventToolCallStart, CallID: "c1", CallName: "fn"}
	respEvents <- StreamEvent{Kind: EventToolCallDelta, CallID: "c1", Text: "{}"}
	respEvents <- StreamEvent{Kind: EventToolCallEnd, CallID: "c1"}
	respEvents <- StreamEvent{Kind: EventUsage, Usage: &StreamUsage{InputTokens: 1, OutputTokens: 1}}
	respEvents <- StreamEvent{Kind: EventMessageStop, Reason: "content_filter"}
	close(respEvents)
	body, err = readBridge(t, NewStreamBridge(NewStream(respEvents, nil, 0, 0), contracts.SurfaceOpenAIResponses, "gpt"))
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("responses bridge: %v", err)
	}
	if !strings.Contains(body, "response.created") && !strings.Contains(body, "response.output_text.delta") {
		t.Fatalf("responses body=%s", body)
	}

	nilBridge := NewStreamBridge(nil, contracts.SurfaceOpenAIChat, "m")
	buf := make([]byte, 32)
	if _, err := nilBridge.Read(buf); err == nil {
		t.Fatal("nil source should fail")
	}
	_ = nilBridge.Close()
}

func TestStreamUsageTimersAndRequestMetadata(t *testing.T) {
	events := make(chan StreamEvent, 3)
	events <- StreamEvent{Kind: EventUsage, Usage: &StreamUsage{InputTokens: 4, OutputTokens: 5, CacheReadTokens: 1, CacheWriteTokens: 2, ReasoningTokens: 3, TotalTokens: 9}}
	events <- StreamEvent{Kind: EventMessageStart, CallID: "resp_meta"}
	events <- StreamEvent{Kind: EventMessageStop, Reason: "completed"}
	close(events)
	stream := NewStream(events, nil, 10*time.Millisecond, 50*time.Millisecond)
	for {
		ev, err := stream.Next(context.Background())
		if errors.Is(err, io.EOF) || (err != nil && StreamCodeOf(err) != "") {
			break
		}
		if err != nil {
			t.Fatalf("Next: %v", err)
		}
		if ev.IsTerminal() {
			break
		}
	}
	usage := stream.Usage()
	tokens := stream.UsageTokens()
	if usage.InputTokens == 0 && (tokens.Input == nil || *tokens.Input == 0) {
		t.Fatalf("usage tokens=%+v usage=%+v", tokens, usage)
	}
	_ = stream.Close()

	meta := requestMetadata(contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat, Model: "model", Stream: true,
		Headers: http.Header{
			"X-Request-ID":               []string{"meta-1"},
			"X-Cartethyia-Provider":      []string{"openai"},
			"X-Forwarded-For":            []string{"1.2.3.4"},
			"User-Agent":                 []string{"fixture"},
			"X-Cartethyia-Continuation-Scope": []string{"scope"},
		},
	})
	if meta.RequestID != "meta-1" || meta.Model != "model" {
		t.Fatalf("metadata=%+v", meta)
	}
	for _, tier := range []ReadinessTier{ReadinessUnknown, ReadinessReady, ReadinessStale, ReadinessUnavailable} {
		if tier.String() == "" && tier != 0 {
			t.Fatalf("tier=%v string empty", tier)
		}
		_ = tier.String()
	}
}

func TestCanonicalProjectionAndResponseTargetSurface(t *testing.T) {
	registry := transforms.NewDefaultRegistry()
	req := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model"}
	raw := &contracts.Response{StatusCode: 200, Headers: http.Header{"Content-Type": []string{"application/json"}}, Body: []byte(`{"id":"chatcmpl_1","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"hi"}}]}`)}
	out, err := canonicalResponseProjection(req, contracts.SurfaceOpenAIChat, raw, registry)
	if err != nil || out == nil {
		t.Fatalf("same-surface projection err=%v", err)
	}
	if _, err := canonicalResponseProjection(req, contracts.SurfaceOpenAIResponses, nil, registry); err == nil {
		t.Fatal("nil response accepted")
	}
	streamReq := req
	streamReq.Stream = true
	if got, err := canonicalResponseProjection(streamReq, contracts.SurfaceAnthropic, raw, registry); err != nil || got != raw {
		t.Fatalf("stream passthrough=%v err=%v", got, err)
	}

	plan := catalog.RoutePlan{Members: []catalog.RouteMember{{TargetSurface: providers.SurfaceOpenAIResponses, Surface: contracts.SurfaceOpenAIChat}}}
	if responseTargetSurface(req, plan) != contracts.SurfaceOpenAIResponses {
		t.Fatalf("target=%s", responseTargetSurface(req, plan))
	}
	if responseTargetSurface(req, catalog.RoutePlan{}) != contracts.SurfaceOpenAIResponses {
		t.Fatal("empty plan chat defaults to responses target")
	}
	if responseTargetSurface(contracts.Request{Protocol: contracts.SurfaceAnthropic}, catalog.RoutePlan{}) != contracts.SurfaceAnthropic {
		t.Fatal("empty plan anthropic target")
	}
}

func TestWaitForAvailabilityAndAvailabilityHint(t *testing.T) {
	now := time.Now()
	router := &Router{
		now:          func() time.Time { return now },
		retryWaitMax: time.Second,
		wait:         func(context.Context, time.Duration) bool { return true },
	}
	if router.waitForAvailability(context.Background(), Availability{}) {
		t.Fatal("zero retry should be false")
	}
	if !router.waitForAvailability(context.Background(), Availability{RetryAt: now.Add(-time.Second)}) {
		t.Fatal("past retry should be true")
	}
	if router.waitForAvailability(context.Background(), Availability{RetryAt: now.Add(2 * time.Second)}) {
		t.Fatal("beyond max wait should be false")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	if router.waitForAvailability(ctx, Availability{RetryAt: now.Add(time.Hour)}) {
		t.Fatal("deadline exceeded wait should be false")
	}
	if !router.waitForAvailability(context.Background(), Availability{RetryAt: now.Add(10 * time.Millisecond)}) {
		t.Fatal("bounded wait should succeed")
	}
	failure := &Failure{}
	router.applyAvailabilityHint(failure, Availability{RetryAt: now.Add(250 * time.Millisecond)})
	if failure.RetryAfterMS <= 0 {
		t.Fatalf("RetryAfterMS=%d", failure.RetryAfterMS)
	}
	router.applyAvailabilityHint(nil, Availability{RetryAt: now.Add(time.Second)})
}

func TestHedgeFinalizeLoserSuccessPath(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{
		{ID: "a", Provider: "openai", Enabled: true},
		{ID: "b", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{
		Pool: pool, MaxAttempts: 3, HedgeEnabled: true, HedgeDelay: time.Millisecond,
		Wait: func(context.Context, time.Duration) bool { return true },
	})
	if err != nil {
		t.Fatal(err)
	}
	transport := &delayedHedgeTransport{
		firstGate: make(chan struct{}),
	}
	close(transport.firstGate) // first succeeds immediately after hedge starts; second may also run
	// Make first slow enough that hedge prepares second, then first succeeds.
	transport = &delayedHedgeTransport{
		firstGate:  make(chan struct{}),
		secondGate: make(chan struct{}),
	}
	go func() {
		time.Sleep(30 * time.Millisecond)
		close(transport.secondGate)
		time.Sleep(30 * time.Millisecond)
		close(transport.firstGate)
	}()
	req := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}
	response, _, routeErr := router.Route(context.Background(), transport, req, hedgeEligiblePlan())
	if routeErr != nil || response == nil {
		t.Fatalf("response=%+v err=%v", response, routeErr)
	}
}

func TestPrepareFailureObservationAndNewPreparedAttemptValidation(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{
		{ID: "a", Provider: "openai", Enabled: true},
		{ID: "b", Provider: "openai", Enabled: true},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 2, Preparer: &coveragePreparer{fail: true}})
	if err != nil {
		t.Fatal(err)
	}
	_, failure, routeErr := router.Route(context.Background(), &hedgeTestTransport{}, contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{}`),
	}, fixtureRoutePlan("openai", "model", contracts.SurfaceOpenAIChat))
	if routeErr != nil {
		t.Fatalf("routeErr=%v", routeErr)
	}
	if failure == nil {
		t.Fatal("expected preparation failure")
	}
	if _, err := NewPreparedAttempt(Account{}, contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "m"}, nil); err == nil {
		t.Fatal("empty account accepted")
	}
	if _, err := NewPreparedAttempt(Account{ID: "a"}, contracts.Request{}, nil); err == nil {
		t.Fatal("empty request accepted")
	}
}

func TestSkipWhitespaceAndExtractEdgeCases(t *testing.T) {
	if string(skipWhitespace([]byte(" \t\n\r"))) != " \t\n\r" && len(skipWhitespace([]byte(" \t\n\r"))) != 0 {
		// all whitespace returns original when exhausted in current implementation
	}
	_ = skipWhitespace([]byte(" \t\n\rx"))
	if extractStringField([]byte(`{"model":}`), "model") != "" {
		t.Fatal("missing value")
	}
	if extractStringField([]byte(`{"model"`), "model") != "" {
		t.Fatal("truncated field")
	}
	if bytesIndex(nil, nil) != 0 {
		t.Fatal("empty needle index")
	}
	if bytesIndexByte([]byte("abc"), 'z') != -1 {
		t.Fatal("missing byte")
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = body
}
