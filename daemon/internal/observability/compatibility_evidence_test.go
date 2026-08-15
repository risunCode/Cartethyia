package observability

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCompatibilityEvidenceIsBoundedAndSecretFree(t *testing.T) {
	reg := NewRegistry()
	secret := "authorization=Bearer task19-secret-sentinel"
	reg.ObserveCompatibilityPlan(CompatibilityPlanEvidence{
		RequestID: secret, SourceSurface: "openai-chat", TargetSurface: "openai-responses",
		Profile: "codex-cli", Action: PlanActionTranslate, Outcome: PlanOutcomePlanned,
		Operation: "generate", Code: secret,
	})
	reg.ObserveProviderCache(ProviderCacheEvidence{
		RequestID: secret, Operation: CacheHit, Outcome: "hit", ReadTokens: 7,
		WriteTokens: 3, EligiblePrefix: 10, HitPrefix: 7,
	})
	rr := httptest.NewRecorder()
	reg.ServeHTTP(rr)
	body := rr.Body.String()
	if strings.Contains(strings.ToLower(body), "task19-secret-sentinel") || strings.Contains(body, "request_id") {
		t.Fatalf("metrics leaked secret or request identity: %s", body)
	}
	for _, metric := range []string{
		"cartethyia_compatibility_plan_outcomes_total",
		"cartethyia_provider_prompt_cache_read_tokens_total 7",
		"cartethyia_provider_prompt_cache_write_tokens_total 3",
	} {
		if !strings.Contains(body, metric) {
			t.Fatalf("missing metric %q in %s", metric, body)
		}
	}
}

func TestCompatibilityEvidenceUnknownDimensionsCollapseToOther(t *testing.T) {
	reg := NewRegistry()
	reg.ObserveCompatibilityPlan(CompatibilityPlanEvidence{
		SourceSurface: strings.Repeat("x", 4096), TargetSurface: "openai-chat",
		Profile: "unknown-profile", Action: "arbitrary-action", Outcome: "arbitrary-outcome",
		Operation: "arbitrary-operation", CompactionVersion: "arbitrary-version", Bridge: "arbitrary-bridge",
	})
	if got := reg.EventCount(StageCompatibilityPlan, []Label{
		{Key: "source_surface", Value: "other"}, {Key: "target_surface", Value: "openai-chat"},
		{Key: "profile", Value: "other"}, {Key: "action", Value: "other"}, {Key: "outcome", Value: "other"},
	}); got != 1 {
		t.Fatalf("unknown dimensions were not bounded into one series: %d", got)
	}
}

func TestEvidenceCountersRemainBounded(t *testing.T) {
	reg := NewRegistry()
	reg.ObserveProviderCache(ProviderCacheEvidence{Operation: CacheHit, ReadTokens: -1, WriteTokens: 1 << 60, EligiblePrefix: 10, HitPrefix: 99})
	reg.ObserveTypedExhaustion(ExhaustionCredential, "credential.expired")
	reg.ObserveHiddenRecovery("retry.local_preparation")
	reg.ObserveAvoidableError("route.hidden_recovery")
	rr := httptest.NewRecorder()
	reg.ServeHTTP(rr)
	body := rr.Body.String()
	if !strings.Contains(body, "cartethyia_typed_exhaustions_total 1") || !strings.Contains(body, "cartethyia_hidden_recoveries_total 1") || !strings.Contains(body, "cartethyia_avoidable_errors_total 1") {
		t.Fatalf("missing bounded counters: %s", body)
	}
	if !strings.Contains(body, "cartethyia_provider_prompt_cache_read_tokens_total 0") || !strings.Contains(body, "cartethyia_provider_prompt_cache_write_tokens_total 0") {
		t.Fatalf("invalid usage was not bounded: %s", body)
	}
}
