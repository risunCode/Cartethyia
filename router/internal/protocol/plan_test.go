package protocol

import (
	"errors"
	"testing"
)

func planTestPolicy() TargetPolicy {
	return TargetPolicy{
		ID: "policy-1", Generation: 1,
		Surfaces:          []Surface{SurfaceOpenAIChat, SurfaceOpenAIResponses, SurfaceAnthropic, SurfaceGemini},
		NativePassthrough: true, BytePreservation: true, SupportsStreaming: true,
		Features: map[Feature]FeaturePolicy{
			FeatureText:             {Supported: true, Translatable: true},
			FeatureTools:            {Supported: true, Translatable: true, RuleID: "tools.translate"},
			FeatureImage:            {Supported: true, Translatable: true},
			FeatureUnknownFields:    {Supported: false, StripNonSemantic: true, RuleID: "unknown.strip.fixture"},
			FeatureStructuredOutput: {Supported: true, Translatable: true, Clamp: true, Max: 4096, RuleID: "output.clamp"},
		},
	}
}

func planTestRequest() PlanRequest {
	return PlanRequest{
		Profile: ProfileCodexCLI, SourceSurface: SurfaceOpenAIChat,
		TargetSurface: SurfaceOpenAIResponses, ProviderID: "openai", ModelID: "gpt-5.6",
		Policy: planTestPolicy(), Generation: generationForPlanTests(),
	}
}

func generationForPlanTests() CacheGeneration {
	return CacheGeneration{Catalog: 1, Health: 1}
}

func TestPlanTranslatesKnownCrossSurfaceFeatures(t *testing.T) {
	req := planTestRequest()
	req.Features = FeatureSet{Features: []Feature{FeatureText, FeatureTools}}
	plan, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan() error = %v", err)
	}
	if plan.Encoder != EncoderOpenAIResponses || plan.SourceEncoder != EncoderOpenAIChat {
		t.Fatalf("encoder selection = %+v", plan)
	}
	for _, d := range plan.Dispositions {
		if d.Action == Reject {
			t.Fatalf("unexpected rejection: %+v", d)
		}
	}
}

func TestPlanRejectsSemanticCapabilityGapWithStableCode(t *testing.T) {
	req := planTestRequest()
	req.Features = FeatureSet{Features: []Feature{FeatureComputerTool}}
	_, err := Plan(req)
	var capability *CapabilityError
	if !errors.As(err, &capability) {
		t.Fatalf("error = %v, want CapabilityError", err)
	}
	if capability.Code != CodeToolKindUnsupported {
		t.Fatalf("code = %q", capability.Code)
	}
	if capability.SourceSurface != SurfaceOpenAIChat {
		t.Fatalf("source surface = %q", capability.SourceSurface)
	}
}

func TestPlanStripsOnlyFixtureBackedNonSemanticFeature(t *testing.T) {
	req := planTestRequest()
	req.Features = FeatureSet{Requirements: []FeatureRequirement{{Feature: FeatureUnknownFields, SourcePath: "/metadata/vendor", Semantic: false}}}
	plan, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan() error = %v", err)
	}
	if len(plan.Dispositions) != 1 || plan.Dispositions[0].Action != StripNonSemantic || plan.Dispositions[0].RuleID == "" {
		t.Fatalf("dispositions = %+v", plan.Dispositions)
	}
}

func TestPlanClampsVerifiedNumericMaximumWithoutRecordingValue(t *testing.T) {
	req := planTestRequest()
	req.Features = FeatureSet{Requirements: []FeatureRequirement{{Feature: FeatureStructuredOutput, SourcePath: "/max_output_tokens", HasNumeric: true, NumericValue: 8192}}}
	plan, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan() error = %v", err)
	}
	d := plan.Dispositions[0]
	if d.Action != Clamp || d.RuleID != "output.clamp" {
		t.Fatalf("disposition = %+v", d)
	}
	if stringifiedPlan := PlanDigest(plan); stringifiedPlan == "" {
		t.Fatal("empty content-free plan digest")
	}
}

func TestPlanRequiresBothLossOptIns(t *testing.T) {
	req := planTestRequest()
	req.LossRequested = true
	_, err := Plan(req)
	var planErr *PlanError
	if !errors.As(err, &planErr) || planErr.Code != CodeLossOptInRequired {
		t.Fatalf("error = %v", err)
	}
	req.Tenant.AllowLossy = true
	req.Policy.LossyEligible = true
	if _, err := Plan(req); err != nil {
		t.Fatalf("opt-in plan error = %v", err)
	}
}

func TestPlanUsesNativePassthroughOnlyWhenByteSafe(t *testing.T) {
	req := planTestRequest()
	req.TargetSurface = req.SourceSurface
	req.NativePassthroughRequested = true
	req.Features = FeatureSet{Features: []Feature{FeatureText}}
	plan, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan() error = %v", err)
	}
	if !plan.SameSurfacePassthrough || plan.Encoder != EncoderOpenAIChat || plan.Dispositions[0].Action != PassthroughNative {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestCompatibilityDecisionModesAndImmutability(t *testing.T) {
	repairs := RepairSet{"model.patch"}
	unsupported := FeatureSet{Features: []Feature{FeatureComputerTool}}
	decision, err := NewCompatibilityDecision(CompatibilityDecision{
		Mode:              ModePatch,
		SourceSurface:     SurfaceOpenAIChat,
		TargetSurface:     SurfaceOpenAIChat,
		RequiredRepairs:   repairs,
		Unsupported:       FeatureSet{},
		CatalogGeneration: 1,
		CapabilityVersion: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	repairs[0] = "mutated"
	unsupported.Features = append(unsupported.Features, FeatureImage)
	if decision.RequiredRepairs[0] != "model.patch" || len(decision.Unsupported.Features) != 0 {
		t.Fatalf("decision was not defensively copied: %+v", decision)
	}
	if decision.CacheKey().Digest() == "" {
		t.Fatal("decision cache key digest is empty")
	}
}

func TestCompatibilityDecisionRejectsInvalidModeInvariants(t *testing.T) {
	_, err := NewCompatibilityDecision(CompatibilityDecision{
		Mode:              ModePass,
		SourceSurface:     SurfaceOpenAIChat,
		TargetSurface:     SurfaceAnthropic,
		ModelPatch:        "replace-model",
		CatalogGeneration: 1,
		CapabilityVersion: 1,
	})
	if err == nil {
		t.Fatal("PASS accepted cross-surface model patch")
	}
}

func TestPlanAssignsDecisionMode(t *testing.T) {
	req := planTestRequest()
	req.SourceSurface = SurfaceOpenAIChat
	req.TargetSurface = SurfaceOpenAIChat
	req.NativePassthroughRequested = true
	req.Features = FeatureSet{Features: []Feature{FeatureText}}
	pass, err := Plan(req)
	if err != nil || pass.Decision.Mode != ModePass {
		t.Fatalf("PASS decision = %+v, %v", pass.Decision, err)
	}

	req.NativePassthroughRequested = false
	req.Features = FeatureSet{Requirements: []FeatureRequirement{{
		Feature: FeatureStructuredOutput, SourcePath: "/max_output_tokens", HasNumeric: true, NumericValue: 8192,
	}}}
	patch, err := Plan(req)
	if err != nil || patch.Decision.Mode != ModePatch {
		t.Fatalf("PATCH decision = %+v, %v", patch.Decision, err)
	}

	req.TargetSurface = SurfaceAnthropic
	req.Features = FeatureSet{Features: []Feature{FeatureText}}
	translated, err := Plan(req)
	if err != nil || translated.Decision.Mode != ModeTranslate {
		t.Fatalf("TRANSLATE decision = %+v, %v", translated.Decision, err)
	}
}
