package cacheplan

import (
	"testing"

	providerpkg "github.com/cartethyia/daemon/internal/providers"
)

func BenchmarkTask22PromptCachePlanHitShape(b *testing.B) {
	payload := map[string]any{"input": []any{
		map[string]any{"role": "system", "content": []any{map[string]any{"type": "input_text", "text": "stable fixture prefix"}}},
		map[string]any{"role": "user", "content": "current fixture turn"},
	}}
	policy := providerpkg.CompatibilityPolicy{Generation: 7, Cache: providerpkg.CachePolicy{Prompt: providerpkg.PromptCachePolicy{Supported: true, Key: true, ExplicitBreakpoint: true, MinPrefixBytes: 1, MarkerLocations: []string{"system", "message"}}}}
	b.ReportAllocs()
	for b.Loop() {
		intent, err := PlanFinalWire(&FinalWireRequest{Protocol: ProtocolOpenAI, Surface: "openai-responses", ProviderID: "fixture-provider", ModelID: "fixture-model", TenantID: "fixture-tenant", PolicyGeneration: 7, Payload: payload}, policy)
		if err != nil || !intent.Eligible {
			b.Fatalf("intent=%#v err=%v", intent, err)
		}
	}
}
