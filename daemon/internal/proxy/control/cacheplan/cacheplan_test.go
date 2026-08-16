package cacheplan

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
)

// TestCachePlanBoundaryAssertions tests that Anthropic cache plan has proper boundary TTL
func TestCachePlanBoundaryAssertions(t *testing.T) {
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

func TestCachePlanTenantScopes(t *testing.T) {
	tests := []struct {
		tenantID string
	}{
		{"tenant-1"},
		{"tenant-2"},
	}
	for _, tt := range tests {
		req := &FinalWireRequest{
			Protocol:   ProtocolOpenAI,
			Surface:    "openai-responses",
			ProviderID: "test-provider",
			ModelID:    "gpt-4",
			Payload: map[string]any{
				"input": []any{"hello"},
			},
			TenantID: tt.tenantID,
		}
		intent, err := PlanFinalWire(req, providers.CompatibilityPolicy{Generation: 7, Cache: providers.CachePolicy{Prompt: providers.PromptCachePolicy{Supported: true, Key: true}}})
		if err != nil {
			t.Errorf("PlanFinalWire for tenant %q failed unexpectedly: %v", tt.tenantID, err)
			continue
		}
		if !intent.Eligible {
			t.Errorf("tenant %q should be eligible", tt.tenantID)
		}
	}
}

func TestCachePlanErrorFormattingAndUnwrap(t *testing.T) {
	var nilErr *Error
	if nilErr.Error() != "<nil>" || nilErr.Unwrap() != nil {
		t.Fatalf("nil Error format = %q", nilErr.Error())
	}
	e := &Error{Code: "code_1", Reason: "bad reason", Cause: errors.New("underlying")}
	if !strings.Contains(e.Error(), "code_1") || !strings.Contains(e.Error(), "bad reason") {
		t.Fatalf("error format = %q", e.Error())
	}
	if !errors.Is(e, e.Cause) {
		t.Fatalf("unwrap failed: %v", e.Unwrap())
	}
	bareErr := &Error{Code: "bare_code"}
	if bareErr.Error() != "bare_code" {
		t.Fatalf("bare error = %q", bareErr.Error())
	}
}

func TestPlanWireAndVariants(t *testing.T) {
	req := &FinalWireRequest{
		Protocol:   ProtocolOpenAI,
		Surface:    "openai-chat",
		ProviderID: "openai",
		ModelID:    "gpt-4o",
		TenantID:   "tenant-x",
		Payload:    map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hello"}}},
	}
	policy := providers.CompatibilityPolicy{Generation: 3, Cache: providers.CachePolicy{Prompt: providers.PromptCachePolicy{Supported: true, Key: true}}}

	// PlanWire
	i1, err := PlanWire(req, policy)
	if err != nil || !i1.Eligible {
		t.Fatalf("PlanWire failed: %+v %v", i1, err)
	}

	// PlanTargetWire
	i2, err := PlanTargetWire(req, policy)
	if err != nil || !i2.Eligible {
		t.Fatalf("PlanTargetWire failed: %+v %v", i2, err)
	}

	// PlanFinalWireWithPromptPolicy
	i3, err := PlanFinalWireWithPromptPolicy(req, policy.Cache.Prompt, 3)
	if err != nil || !i3.Eligible {
		t.Fatalf("PlanFinalWireWithPromptPolicy failed: %+v %v", i3, err)
	}

	// PlanWithOptions error paths
	if _, err := PlanWithOptions(Protocol("invalid"), nil, true, PlanOptions{}); err == nil {
		t.Fatal("nil req should fail")
	}
	normReq := &transforms.NormalizedRequest{}
	if _, err := PlanWithOptions(Protocol("invalid"), normReq, true, PlanOptions{}); err == nil {
		t.Fatal("invalid protocol should fail")
	}
	if _, err := PlanWithOptions(ProtocolOpenAI, normReq, true, PlanOptions{TTLSeconds: 300}); err == nil {
		t.Fatal("OpenAI with TTL should fail")
	}

	// PlanOpenAI disabled
	intentOpenAIDisabled, err := PlanOpenAI(normReq, false)
	if err != nil || intentOpenAIDisabled.Supported {
		t.Fatalf("disabled OpenAI plan = %+v %v", intentOpenAIDisabled, err)
	}

	// PlanAnthropic disabled
	intentAnthropicDisabled, err := PlanWithOptions(ProtocolAnthropic, normReq, false, PlanOptions{})
	if err != nil || intentAnthropicDisabled.Supported {
		t.Fatalf("disabled Anthropic plan = %+v %v", intentAnthropicDisabled, err)
	}
}

func TestParseUsageCheckedAndVariants(t *testing.T) {
	raw := map[string]any{
		"usage": map[string]any{
			"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
			"prompt_tokens_details": map[string]any{"cached_tokens": 50},
		},
	}
	u, err := ParseUsageChecked(ProtocolOpenAI, raw)
	if err != nil || u.Read == nil || *u.Read != 50 {
		t.Fatalf("ParseUsageChecked = %+v %v", u, err)
	}

	// Number helper cases
	cases := []struct {
		val  any
		want int64
		ok   bool
	}{
		{int(42), 42, true},
		{int64(42), 42, true},
		{float64(42), 42, true},
		{"42", 0, false},
		{"bad", 0, false},
		{nil, 0, false},
	}
	for i, c := range cases {
		got, ok := number(c.val)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("case %d: number(%v) = (%d, %v), want (%d, %v)", i, c.val, got, ok, c.want, c.ok)
		}
	}
}
