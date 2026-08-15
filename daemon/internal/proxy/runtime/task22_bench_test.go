package proxy

import (
	"context"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
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
		attempt, err := NewPreparedAttempt(account, request, nil)
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
