package cacheplan

import (
	"errors"
	"strings"
	"testing"
	"time"

	providerpkg "github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
)

func textBlock(text string) transforms.ContentBlock {
	return transforms.ContentBlock{Type: transforms.BlockText, Text: text}
}

func finalWirePolicy(min int, ttl ...time.Duration) providerpkg.CompatibilityPolicy {
	return providerpkg.CompatibilityPolicy{Generation: 7, Cache: providerpkg.CachePolicy{Prompt: providerpkg.PromptCachePolicy{Supported: true, Key: true, ExplicitBreakpoint: true, MinPrefixBytes: min, MarkerLocations: []string{"system", "tools", "message"}, TTLs: ttl}}}
}

func TestPlanFinalWireOpenAIIsScopedAndMarkerLast(t *testing.T) {
	payload := map[string]any{"input": []any{
		map[string]any{"role": "system", "content": []any{map[string]any{"type": "input_text", "text": strings.Repeat("stable ", 20)}}},
		map[string]any{"role": "user", "content": "current"},
	}}
	first, err := PlanFinalWire(&FinalWireRequest{Protocol: ProtocolOpenAI, Surface: "openai-responses", ProviderID: "openai", ModelID: "gpt-test", TenantID: "tenant-a", PolicyGeneration: 7, Payload: payload}, finalWirePolicy(1))
	if err != nil || !first.Eligible || first.CacheKey == "" {
		t.Fatalf("intent=%#v err=%v", first, err)
	}
	input, _ := payload["input"].([]any)
	system, _ := input[0].(map[string]any)
	blocks, _ := system["content"].([]any)
	if _, ok := blocks[0].(map[string]any)["prompt_cache_breakpoint"]; !ok {
		t.Fatal("missing final OpenAI marker")
	}
	second := payload
	secondIntent, err := PlanFinalWire(&FinalWireRequest{Protocol: ProtocolOpenAI, Surface: "openai-responses", ProviderID: "openai", ModelID: "gpt-test", TenantID: "tenant-b", PolicyGeneration: 7, Payload: second}, finalWirePolicy(1))
	if err != nil || first.CacheKey == secondIntent.CacheKey {
		t.Fatal("cross-tenant cache identity collision")
	}
}

func TestPlanFinalWireAnthropicTTLAndVolatileBoundary(t *testing.T) {
	payload := map[string]any{"system": []any{
		map[string]any{"type": "text", "text": strings.Repeat("stable ", 20)},
		map[string]any{"type": "text", "text": "volatile 2026-08-15T12:00:00"},
	}, "messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "turn"}}}},
	}
	intent, err := PlanFinalWire(&FinalWireRequest{Protocol: ProtocolAnthropic, Surface: "anthropic-messages", ProviderID: "anthropic", ModelID: "claude-test", TenantID: "tenant-a", PolicyGeneration: 7, Payload: payload}, finalWirePolicy(1, time.Hour))
	if err != nil || !intent.Eligible || intent.TTL != "1h" {
		t.Fatalf("intent=%#v err=%v", intent, err)
	}
	system, _ := payload["system"].([]any)
	if _, ok := system[0].(map[string]any)["cache_control"]; !ok {
		t.Fatal("marker was not placed before volatile boundary")
	}
	if _, ok := system[1].(map[string]any)["cache_control"]; ok {
		t.Fatal("volatile block received cache marker")
	}
	if _, ok := payload["prompt_cache_key"]; ok {
		t.Fatal("Anthropic wire received OpenAI cache key")
	}
}

func TestPlanUsesWireProtocolAndStablePrefix(t *testing.T) {
	req := &transforms.NormalizedRequest{CacheKey: "", Messages: []transforms.NormalizedMessage{{Role: transforms.RoleUser, Content: []transforms.ContentBlock{{Type: transforms.BlockText, Text: "hello"}}}}}
	a, err := Plan(ProtocolOpenAI, req, true)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Plan(ProtocolOpenAI, req, true)
	if err != nil {
		t.Fatal(err)
	}
	if a.Protocol != ProtocolOpenAI || a.CacheKey != b.CacheKey || !a.MarkerLast {
		t.Fatalf("plan=%#v", a)
	}
}

func TestParseUsageSeparatesProviderCacheFields(t *testing.T) {
	read := ParseUsage(ProtocolOpenAI, map[string]any{"usage": map[string]any{"prompt_tokens_details": map[string]any{"cached_tokens": float64(7)}}})
	if read.Read == nil || *read.Read != 7 {
		t.Fatalf("openai=%#v", read)
	}
	write := ParseUsage(ProtocolAnthropic, map[string]any{"usage": map[string]any{"cache_read_input_tokens": float64(3), "cache_creation_input_tokens": float64(4)}})
	if write.Read == nil || write.Write == nil || *write.Read != 3 || *write.Write != 4 {
		t.Fatalf("anthropic=%#v", write)
	}
}

func TestAnthropicPlanRendersSystemToolAndMessageBoundaries(t *testing.T) {
	req := &transforms.NormalizedRequest{
		Messages: []transforms.NormalizedMessage{
			{Role: transforms.RoleSystem, Content: []transforms.ContentBlock{textBlock("stable system")}},
			{Role: transforms.RoleUser, Content: []transforms.ContentBlock{textBlock("stable user")}},
		},
		Tools: []transforms.Tool{{Name: "lookup", InputSchema: map[string]any{"type": "object"}}},
	}
	intent, err := PlanAnthropicWithTTL(req, true, AnthropicTTL1Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !intent.Eligible || intent.ProviderMode != AnthropicProviderMode || intent.TTL != "1h" || intent.TTLSeconds != AnthropicTTL1Hour {
		t.Fatalf("intent=%#v", intent)
	}
	if len(intent.Breakpoints) != 3 {
		t.Fatalf("breakpoints=%#v", intent.Breakpoints)
	}
	if intent.Breakpoints[0].Kind != BoundarySystem || intent.Breakpoints[1].Kind != BoundaryTools || intent.Breakpoints[2].Kind != BoundaryMessage {
		t.Fatalf("boundary order=%#v", intent.Breakpoints)
	}
	for _, point := range intent.Breakpoints {
		if point.TTLSeconds != AnthropicTTL1Hour {
			t.Fatalf("point=%#v", point)
		}
	}
}

func TestAnthropicPlanRejectsUnsafeMarkerWithoutEmittingIt(t *testing.T) {
	req := &transforms.NormalizedRequest{
		Messages: []transforms.NormalizedMessage{{
			Role:    transforms.RoleAssistant,
			Content: []transforms.ContentBlock{{Type: transforms.BlockText, Text: "provider output", CacheControl: "ephemeral"}},
		}},
	}
	intent, err := PlanAnthropic(req, true)
	if err == nil || !errors.Is(err, ErrInvalidBoundary) {
		t.Fatalf("err=%v, want invalid boundary", err)
	}
	if len(intent.Breakpoints) != 0 || intent.DisabledCode != CodeInvalidBoundary {
		t.Fatalf("unsafe intent=%#v", intent)
	}
}

func TestAnthropicUsagePreservesUnknownAndTTLBreakdown(t *testing.T) {
	missing := ParseUsage(ProtocolAnthropic, map[string]any{"id": "message"})
	if missing.Source != "missing" || missing.Read != nil || missing.Write != nil || missing.CreationByTTL != nil {
		t.Fatalf("missing=%#v", missing)
	}
	usage := ParseUsage(ProtocolAnthropic, map[string]any{"usage": map[string]any{
		"cache_creation": map[string]any{"ephemeral_5m_input_tokens": float64(11), "ephemeral_1h_input_tokens": float64(0)},
	}})
	if usage.Read != nil || usage.Write != nil || usage.Creation5m == nil || *usage.Creation5m != 11 || usage.Creation1h == nil || *usage.Creation1h != 0 {
		t.Fatalf("ttl usage=%#v", usage)
	}
	if usage.CreationByTTL["5m"] == nil || usage.CreationByTTL["1h"] == nil {
		t.Fatalf("ttl map=%#v", usage.CreationByTTL)
	}
}

func TestAnthropicStablePrefixIgnoresVolatileSuffix(t *testing.T) {
	base := &transforms.NormalizedRequest{Messages: []transforms.NormalizedMessage{{
		Role:    transforms.RoleUser,
		Content: []transforms.ContentBlock{textBlock("stable context")},
	}}}
	volatile := &transforms.NormalizedRequest{Messages: []transforms.NormalizedMessage{{
		Role:    transforms.RoleUser,
		Content: []transforms.ContentBlock{textBlock("stable context"), textBlock("request at 2026-08-13T12:00:00Z")},
	}}}
	first, err := PlanAnthropic(base, true)
	if err != nil {
		t.Fatal(err)
	}
	second, err := PlanAnthropic(volatile, true)
	if err == nil || !errors.Is(err, ErrInvalidBoundary) {
		t.Fatalf("volatile err=%v, want explicit bypass", err)
	}
	if first.Fingerprint != second.Fingerprint {
		t.Fatalf("fingerprint changed across volatile suffix: %q != %q", first.Fingerprint, second.Fingerprint)
	}
}

func TestOpenAIPlanExcludesVolatileSuffixFromFingerprint(t *testing.T) {
	stable := "stable instructions that are reused across requests"
	base := &transforms.NormalizedRequest{
		Model: "gpt-5.6",
		Messages: []transforms.NormalizedMessage{{
			Role:    transforms.RoleUser,
			Content: []transforms.ContentBlock{textBlock(stable)},
		}},
	}
	withSuffix := &transforms.NormalizedRequest{
		Model: "gpt-5.6",
		Messages: []transforms.NormalizedMessage{{
			Role: transforms.RoleUser,
			Content: []transforms.ContentBlock{
				textBlock(stable),
				textBlock("request at 2026-08-13T12:00:00Z"),
			},
		}},
	}
	first, err := PlanOpenAI(base, true)
	if err != nil {
		t.Fatal(err)
	}
	second, err := PlanOpenAI(withSuffix, true)
	if err != nil {
		t.Fatal(err)
	}
	if first.Fingerprint == "" || first.Fingerprint != second.Fingerprint {
		t.Fatalf("volatile suffix changed fingerprint: %#v %#v", first, second)
	}
	if second.StablePrefix == "" || strings.Contains(second.StablePrefix, "request id") {
		t.Fatalf("volatile suffix leaked into stable prefix: %q", second.StablePrefix)
	}
	if len(second.Breakpoints) != 1 || second.Breakpoints[0].MessageIndex != 0 {
		t.Fatalf("breakpoint=%#v", second.Breakpoints)
	}
}

func TestOpenAIPlanGatesUnsupportedModelFields(t *testing.T) {
	req := &transforms.NormalizedRequest{
		Model: "gpt-4o",
		Messages: []transforms.NormalizedMessage{{
			Role:    transforms.RoleUser,
			Content: []transforms.ContentBlock{textBlock("stable")},
		}},
	}
	intent, err := PlanOpenAI(req, true)
	if err != nil {
		t.Fatal(err)
	}
	if !intent.Supported || !intent.Eligible || intent.CacheKey == "" {
		t.Fatalf("intent=%#v", intent)
	}
	if len(intent.Breakpoints) != 0 {
		t.Fatalf("unsafe explicit fields for unsupported model: %#v", intent.Breakpoints)
	}
	disabled, err := PlanOpenAI(req, false)
	if err != nil {
		t.Fatal(err)
	}
	if disabled.Supported || disabled.Eligible || disabled.CacheKey != "" || disabled.StablePrefix != "" || disabled.DisabledCode != CodeUnsupportedCapability {
		t.Fatalf("unsupported intent emitted cache fields: %#v", disabled)
	}
}

func TestOpenAIUsagePreservesUnknownAndParsesWriteEvidence(t *testing.T) {
	missing := ParseUsage(ProtocolOpenAI, map[string]any{"id": "response"})
	if missing.Source != "missing" || missing.Read != nil || missing.Write != nil {
		t.Fatalf("missing=%#v", missing)
	}
	usage, err := ParseUsageChecked(ProtocolOpenAI, map[string]any{"usage": map[string]any{
		"prompt_tokens_details": map[string]any{
			"cached_tokens":      float64(0),
			"cache_write_tokens": float64(9),
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if usage.Read == nil || *usage.Read != 0 || usage.Write == nil || *usage.Write != 9 {
		t.Fatalf("usage=%#v", usage)
	}
	if _, err := ParseUsageChecked(ProtocolOpenAI, map[string]any{"usage": map[string]any{
		"prompt_tokens_details": map[string]any{"cached_tokens": "unknown"},
	}}); err == nil || !errors.Is(err, ErrInvalidUsage) {
		t.Fatalf("invalid usage error=%v", err)
	}
}
