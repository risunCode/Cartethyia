package router

import (
	"context"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/router/catalog"
)

func BenchmarkTask22HedgeEligibility(b *testing.B) {
	router := &Router{hedgeEnabled: true, maxHedges: 1}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fixture-model", Body: []byte(`{"messages":[{"role":"user","content":"fixture"}]}`)}
	plan := catalog.RoutePlan{Operation: catalog.OperationGenerate, Members: []catalog.RouteMember{{ProviderID: "fixture", UpstreamModelID: "fixture-model"}, {ProviderID: "fixture", UpstreamModelID: "fixture-model"}}}
	b.ReportAllocs()
	for b.Loop() {
		if !router.hedgeEligible(request, plan) {
			b.Fatal("fixture request unexpectedly ineligible")
		}
	}
}

func BenchmarkTask22PreparedAttempt(b *testing.B) {
	account := Account{ID: "fixture-account", Provider: "fixture", Model: "fixture-model", Enabled: true}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fixture-model", Body: []byte(`{"messages":[{"role":"user","content":"fixture"}]}`)}
	b.ReportAllocs()
	for b.Loop() {
		attempt, err := NewPreparedAttemptWithDecision(account, request, contracts.CompatibilityDecision{}, nil)
		if err != nil {
			b.Fatal(err)
		}
		if err := attempt.Close(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTask22StreamEventLifecycle(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		stream := NewStream(make(chan StreamEvent, 1), nil, 0, 0)
		stream.ch <- StreamEvent{Kind: EventMessageStop, Reason: "completed"}
		if _, err := stream.Next(context.Background()); err != nil {
			b.Fatal(err)
		}
		if err := stream.Close(); err != nil {
			b.Fatal(err)
		}
	}
}

type task22SuccessTransport struct{}

func (task22SuccessTransport) Call(context.Context, Account, contracts.Request) (*contracts.Response, error) {
	return &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":true}`)}, nil
}

type task22RetryTransport struct {
	calls int
}

func (t *task22RetryTransport) Call(_ context.Context, account Account, _ contracts.Request) (*contracts.Response, error) {
	t.calls++
	if t.calls%2 == 1 {
		return nil, &contracts.RouteError{
			Kind:                     contracts.ErrorTransient,
			Provider:                 account.Provider,
			StatusCode:               503,
			Message:                  "bounded fixture retry",
			Retryable:                true,
			AlternateAccountEligible: true,
			RateScope:                contracts.RateScopeAccount,
			Scope:                    contracts.RateScopeAccount,
			RatePhase:                contracts.RatePhaseProvider,
			Phase:                    contracts.RatePhaseProvider,
		}
	}
	return &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":true}`)}, nil
}

type task22ExhaustionTransport struct{}

func (task22ExhaustionTransport) Call(_ context.Context, account Account, _ contracts.Request) (*contracts.Response, error) {
	return nil, &contracts.RouteError{
		Kind:                     contracts.ErrorTransient,
		Provider:                 account.Provider,
		StatusCode:               503,
		Message:                  "bounded fixture exhaustion",
		Retryable:                true,
		AlternateAccountEligible: true,
		RateScope:                contracts.RateScopeAccount,
		Scope:                    contracts.RateScopeAccount,
		RatePhase:                contracts.RatePhaseProvider,
		Phase:                    contracts.RatePhaseProvider,
	}
}

type task22StreamTransport struct{}

func (task22StreamTransport) CallStream(context.Context, Account, contracts.Request) (*Stream, error) {
	ch := make(chan StreamEvent, 1)
	ch <- StreamEvent{Kind: EventTextDelta, Text: "fixture"}
	close(ch)
	return NewStream(ch, nil, 0, 0), nil
}

func BenchmarkTask22RouterOrdinarySuccess(b *testing.B) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{{ID: "fixture-a", Provider: "fixture", Model: "fixture-model", Enabled: true}}}})
	if err != nil {
		b.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 1})
	if err != nil {
		b.Fatal(err)
	}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fixture-model", Body: []byte(`{"messages":[{"role":"user","content":"fixture"}]}`)}
	plan := fixtureRoutePlan("fixture", "fixture-model", contracts.SurfaceOpenAIChat)
	transport := task22SuccessTransport{}
	b.ReportAllocs()
	for b.Loop() {
		response, failure, routeErr := router.Route(context.Background(), transport, request, plan)
		if routeErr != nil || failure != nil || response == nil {
			b.Fatalf("response=%#v failure=%#v err=%v", response, failure, routeErr)
		}
	}
}

func BenchmarkTask22RouterOneRetry(b *testing.B) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{
		{ID: "fixture-a", Provider: "fixture", Model: "fixture-model", Enabled: true},
		{ID: "fixture-b", Provider: "fixture", Model: "fixture-model", Enabled: true},
	}}})
	if err != nil {
		b.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 2})
	if err != nil {
		b.Fatal(err)
	}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fixture-model", Body: []byte(`{"messages":[{"role":"user","content":"fixture"}]}`)}
	plan := fixtureRoutePlan("fixture", "fixture-model", contracts.SurfaceOpenAIChat)
	transport := &task22RetryTransport{}
	b.ReportAllocs()
	for b.Loop() {
		response, failure, routeErr := router.Route(context.Background(), transport, request, plan)
		if routeErr != nil || failure != nil || response == nil {
			b.Fatalf("response=%#v failure=%#v err=%v", response, failure, routeErr)
		}
		transport.calls = 0
		pool.Reset("fixture-a")
		pool.Reset("fixture-b")
	}
}

func BenchmarkTask22RouterExhaustion(b *testing.B) {
	accounts := []Account{
		{ID: "fixture-a", Provider: "fixture", Model: "fixture-model", Enabled: true},
		{ID: "fixture-b", Provider: "fixture", Model: "fixture-model", Enabled: true},
		{ID: "fixture-c", Provider: "fixture", Model: "fixture-model", Enabled: true},
	}
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: accounts}})
	if err != nil {
		b.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 3})
	if err != nil {
		b.Fatal(err)
	}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fixture-model", Body: []byte(`{"messages":[{"role":"user","content":"fixture"}]}`)}
	plan := fixtureRoutePlan("fixture", "fixture-model", contracts.SurfaceOpenAIChat)
	transport := task22ExhaustionTransport{}
	b.ReportAllocs()
	for b.Loop() {
		response, failure, routeErr := router.Route(context.Background(), transport, request, plan)
		if routeErr != nil || failure == nil || response != nil {
			b.Fatalf("response=%#v failure=%#v err=%v", response, failure, routeErr)
		}
		for _, account := range accounts {
			pool.Reset(account.ID)
		}
	}
}

func BenchmarkTask22StreamPreflight(b *testing.B) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{{ID: "fixture-a", Provider: "fixture", Model: "fixture-model", Enabled: true}}}})
	if err != nil {
		b.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 1})
	if err != nil {
		b.Fatal(err)
	}
	request := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fixture-model", Stream: true, Body: []byte(`{"stream":true,"messages":[{"role":"user","content":"fixture"}]}`)}
	plan := fixtureRoutePlan("fixture", "fixture-model", contracts.SurfaceOpenAIChat)
	transport := task22StreamTransport{}
	b.ReportAllocs()
	for b.Loop() {
		stream, _, failure, routeErr := router.RouteStream(context.Background(), transport, request, plan)
		if routeErr != nil || failure != nil || stream == nil {
			b.Fatalf("stream=%#v failure=%#v err=%v", stream, failure, routeErr)
		}
		if err := stream.Close(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTask22StreamFrameEncoding(b *testing.B) {
	cases := []struct {
		name    string
		surface contracts.Surface
		event   StreamEvent
	}{
		{name: "chat-text", surface: contracts.SurfaceOpenAIChat, event: StreamEvent{Kind: EventTextDelta, Text: "fixture"}},
		{name: "chat-tool-start", surface: contracts.SurfaceOpenAIChat, event: StreamEvent{Kind: EventToolCallStart, CallID: "fixture-call", CallName: "lookup"}},
		{name: "chat-tool-delta", surface: contracts.SurfaceOpenAIChat, event: StreamEvent{Kind: EventToolCallDelta, CallID: "fixture-call", Text: `{"q":"x"}`}},
		{name: "chat-reasoning", surface: contracts.SurfaceOpenAIChat, event: StreamEvent{Kind: EventThinkingDelta, Text: "fixture reasoning"}},
		{name: "chat-usage", surface: contracts.SurfaceOpenAIChat, event: StreamEvent{Kind: EventUsage, Usage: &StreamUsage{InputTokens: 2, OutputTokens: 3, TotalTokens: 5}}},
		{name: "chat-terminal", surface: contracts.SurfaceOpenAIChat, event: StreamEvent{Kind: EventMessageStop, Reason: "completed"}},
		{name: "anthropic-text", surface: contracts.SurfaceAnthropic, event: StreamEvent{Kind: EventTextDelta, Text: "fixture"}},
		{name: "responses-text", surface: contracts.SurfaceOpenAIResponses, event: StreamEvent{Kind: EventTextDelta, Text: "fixture"}},
		{name: "gemini-text", surface: contracts.SurfaceGemini, event: StreamEvent{Kind: EventTextDelta, Text: "fixture"}},
	}
	for _, tc := range cases {
		b.Run(tc.name, func(b *testing.B) {
			state := bridgeState{id: "fixture-stream", created: 1, tools: make(map[string]toolState), toolByIndex: make(map[int]string)}
			b.ReportAllocs()
			for b.Loop() {
				state.started = false
				state.finished = false
				state.sawTool = false
				state.seq = 0
				state.textOpen = false
				state.thinkOpen = false
				clear(state.tools)
				clear(state.toolByIndex)
				if tc.event.Kind == EventToolCallDelta {
					state.tools[tc.event.CallID] = toolState{index: 0, name: "lookup"}
				}
				if frames, err := state.encode(tc.surface, tc.event, "fixture-model"); err != nil || len(frames) == 0 {
					b.Fatalf("frames=%d err=%v", len(frames), err)
				}
			}
		})
	}
}
