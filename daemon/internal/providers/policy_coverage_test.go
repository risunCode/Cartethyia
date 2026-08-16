package providers

import (
	"testing"
	"time"
)

func TestCompatibilityPolicyCloneValidationAndCapabilities(t *testing.T) {
	p := CompatibilityPolicy{
		Generation: 2,
		Parameters: ParameterPolicy{Unsupported: []string{"temperature"}},
		Tools: ToolPolicy{SupportedKinds: []ToolKind{ToolFunction}, Function: true},
		Reasoning: ReasoningPolicy{Enabled: true, Formats: []string{"summary"}},
		Media: MediaPolicy{Kinds: []MediaKind{MediaImage}, References: []ReferenceKind{ReferenceURL}, MIMETypes: []string{"image/png"}, Capabilities: []MediaCapability{{Kind: MediaImage, References: []ReferenceKind{ReferenceURL}, MIMETypes: []string{"image/png"}, Detail: []string{"high"}}}},
		Cache: CachePolicy{Prompt: PromptCachePolicy{Supported: true, MinPrefixBytes: 1, TTLs: []time.Duration{time.Minute}}},
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	clone := p.Clone()
	clone.Parameters.Unsupported[0] = "changed"
	clone.Media.Capabilities[0].Detail[0] = "changed"
	if p.Parameters.Unsupported[0] == "changed" || p.Media.Capabilities[0].Detail[0] == "changed" {
		t.Fatal("Clone did not defensively copy nested slices")
	}
	if !p.SupportsToolKind(ToolFunction) || !p.SupportsMedia(MediaImage, ReferenceURL, "image/png") {
		t.Fatal("capability support lookup failed")
	}
	if p.SupportsCompaction(CompactionV1) {
		t.Fatal("unexpected compaction support")
	}
	if p.SupportsMedia(MediaImage, ReferenceInlineData, "image/png") || p.SupportsMedia(MediaImage, ReferenceURL, "image/jpeg") {
		t.Fatal("media restrictions were ignored")
	}
	if len(p.RulesCopy()) != 0 {
		t.Fatal("unexpected rules")
	}
}

func TestCompatibilityPolicyRejectsInvalidDataAndRetainsGeneration(t *testing.T) {
	cases := []CompatibilityPolicy{
		{Generation: 0},
		{Generation: 1, Parameters: ParameterPolicy{MaxOutput: -1}},
		{Generation: 1, Reasoning: ReasoningPolicy{Formats: []string{"x"}}},
		{Generation: 1, Tools: ToolPolicy{SupportedKinds: []ToolKind{"unknown"}}},
		{Generation: 1, Streaming: StreamingPolicy{ForceUpstream: true}},
		{Generation: 1, Media: MediaPolicy{Loss: LossyMediaPolicy{Allowed: true}}},
		{Generation: 1, Cache: CachePolicy{Prompt: PromptCachePolicy{Supported: true}}},
		{Generation: 1, Execution: ExecutionPolicy{Hedge: HedgePolicy{Allowed: true}}},
		{Generation: 1, Compaction: RemoteCompactionPolicy{Versions: []CompactionVersion{"unknown"}}},
		{Generation: 1, Parameters: ParameterPolicy{Rules: []PolicyRule{{ID: "same", Fixture: "f", Action: PolicyPreserve}, {ID: "same", Fixture: "f", Action: PolicyPreserve}}}},
	}
	for i, candidate := range cases {
		if err := candidate.Validate(); err == nil {
			t.Errorf("case %d unexpectedly validated", i)
		}
	}
	valid := PolicyGeneration{Generation: 1, Policy: CompatibilityPolicy{Generation: 1}}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := ValidatePolicyGeneration(valid, PolicyGeneration{Generation: 0}); err == nil {
		t.Fatal("generation rollback/invalid candidate accepted")
	}
	retained, err := RetainLastValidPolicy(&valid, PolicyGeneration{Generation: 0})
	if err == nil || retained.Generation != 1 {
		t.Fatalf("invalid candidate did not retain prior policy: %#v, %v", retained, err)
	}
	if _, err := RetainLastValidPolicy(nil, PolicyGeneration{Generation: 0}); err == nil {
		t.Fatal("invalid candidate without prior unexpectedly accepted")
	}
	errValue := NewCapabilityError("code", "feature", SurfaceOpenAIChat, "op", "model", "requested", []string{"z", "a"})
	if errValue.Error() == "" || errValue.Validate() != nil || errValue.Alternatives[0] != "a" {
		t.Fatalf("capability error malformed: %#v", errValue)
	}
	if (&CapabilityError{}).Validate() == nil {
		t.Fatal("invalid capability error unexpectedly validated")
	}
}

func TestLegacyAndEffectiveCompatibility(t *testing.T) {
	caps := ProviderCaps{Streaming: true, Reasoning: true, ToolCalls: true, Images: true, Search: true, ExplicitCache: true}
	legacy := LegacyCompatibilityPolicy(caps)
	if !legacy.Streaming.Supported || !legacy.Reasoning.Enabled || !legacy.SupportsToolKind(ToolWebSearch) || !legacy.SupportsMedia(MediaImage, ReferenceURL, "") {
		t.Fatalf("legacy policy missing capabilities: %#v", legacy)
	}
	effective := EffectiveCompatibilityPolicy(caps, nil)
	if effective.Generation != 1 {
		t.Fatalf("unexpected effective generation: %d", effective.Generation)
	}
	model := Model("id", "ID", &ProviderCaps{Reasoning: true})
	if !EffectiveCompatibilityPolicy(caps, &model).Reasoning.Enabled {
		t.Fatal("model legacy policy should override provider")
	}
}
