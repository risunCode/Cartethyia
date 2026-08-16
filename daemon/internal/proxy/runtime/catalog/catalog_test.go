package catalog

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/providers/adapters"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
)

func testRegistry(t *testing.T) *providers.Registry {
	t.Helper()
	r := providers.NewRegistry()
	r.Register(adapters.NewOpenAIAdapter(adapters.OpenAIAdapterConfig{
		ID: "fixture", DisplayName: "Fixture", BaseURL: "http://127.0.0.1",
		Surfaces: []providers.Surface{providers.SurfaceOpenAIChat},
		Models:   []providers.ProviderModel{providers.Model("native-model", "Native", nil)},
	}))
	return r
}

func TestBuilderResolvesAliasesAndCombos(t *testing.T) {
	b, err := NewBuilder(testRegistry(t))
	if err != nil {
		t.Fatal(err)
	}
	s, err := b.Build(context.Background(), StaticSource{Gen: 4, AliasList: []Alias{{Alias: "friendly", Target: "native-model"}}, CombinationList: []Combination{{ID: "fallback", Members: []string{"friendly"}, Strategy: "fallback"}}})
	if err != nil {
		t.Fatal(err)
	}
	model, err := s.Resolve("friendly")
	if err != nil {
		t.Fatal(err)
	}
	if model.ID != "native-model" || model.ProviderID != "fixture" {
		t.Fatalf("model = %#v", model)
	}
	plan, err := s.Plan("fallback", contracts.SurfaceOpenAIChat)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Strategy != RouteStrategyFallback || len(plan.Members) != 1 || plan.Members[0].ProviderID != "fixture" || plan.Members[0].UpstreamModelID != "native-model" {
		t.Fatalf("plan = %#v", plan)
	}
	if s.Generation != 4 {
		t.Fatalf("generation = %d", s.Generation)
	}
}

func TestPlanForSelectsIndependentProviderTargetSurface(t *testing.T) {
	registry := providers.NewRegistry()
	responses := providers.ProviderCaps{Surfaces: []providers.Surface{providers.SurfaceOpenAIResponses}, Streaming: true, ToolCalls: true, Images: true}
	if err := registry.Register(adapters.NewOpenAIAdapter(adapters.OpenAIAdapterConfig{
		ID: "responses-only", DisplayName: "Responses", BaseURL: "http://127.0.0.1",
		Surfaces: []providers.Surface{providers.SurfaceOpenAIResponses},
		Models:   []providers.ProviderModel{providers.Model("native", "Native", &responses)},
	})); err != nil {
		t.Fatal(err)
	}
	b, err := NewBuilder(registry)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := b.Build(context.Background(), StaticSource{Gen: 9})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := snapshot.PlanFor("native", RoutePlanningInput{
		SourceSurface: contracts.SurfaceOpenAIChat,
		Operation:     transforms.OperationGenerate,
		Requirements:  FeatureRequirements{Hard: []FeatureRequirement{FeatureVision}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Members) != 1 || plan.Members[0].SourceSurface != contracts.SurfaceOpenAIChat || plan.Members[0].TargetSurface != providers.SurfaceOpenAIResponses || plan.Members[0].Surface != contracts.SurfaceOpenAIChat {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestPlanForRejectsHardFeatureBeforeAccountPlanning(t *testing.T) {
	registry := providers.NewRegistry()
	caps := providers.ProviderCaps{Surfaces: []providers.Surface{providers.SurfaceOpenAIResponses}, Streaming: true, ToolCalls: false, Images: false}
	if err := registry.Register(adapters.NewOpenAIAdapter(adapters.OpenAIAdapterConfig{
		ID: "limited", DisplayName: "Limited", BaseURL: "http://127.0.0.1",
		Surfaces: []providers.Surface{providers.SurfaceOpenAIResponses},
		Models:   []providers.ProviderModel{providers.Model("limited", "Limited", &caps)},
	})); err != nil {
		t.Fatal(err)
	}
	b, _ := NewBuilder(registry)
	snapshot, err := b.Build(context.Background(), StaticSource{Gen: 2})
	if err != nil {
		t.Fatal(err)
	}
	_, err = snapshot.PlanFor("limited", RoutePlanningInput{SourceSurface: contracts.SurfaceOpenAIChat, Operation: transforms.OperationGenerate, Requirements: FeatureRequirements{Hard: []FeatureRequirement{FeatureNativeTool}}})
	var capabilityErr *CapabilityError
	if !errors.As(err, &capabilityErr) || capabilityErr.Code != "capability.tool_unsupported" || capabilityErr.Feature != FeatureNativeTool {
		t.Fatalf("error = %v, want bounded tool capability error", err)
	}
}

func TestBuilderRejectsAliasCycleAndUnknownCombo(t *testing.T) {
	b, _ := NewBuilder(testRegistry(t))
	_, err := b.Build(context.Background(), StaticSource{AliasList: []Alias{{Alias: "a", Target: "b"}, {Alias: "b", Target: "a"}}})
	if !errors.Is(err, ErrAliasCycle) {
		t.Fatalf("cycle error = %v", err)
	}
	_, err = b.Build(context.Background(), StaticSource{CombinationList: []Combination{{ID: "bad", Members: []string{"missing"}, Strategy: "fallback"}}})
	if !errors.Is(err, ErrUnknownModel) {
		t.Fatalf("unknown error = %v", err)
	}
}

func TestBuilderRejectsInvalidCombinationContracts(t *testing.T) {
	b, _ := NewBuilder(testRegistry(t))
	tests := []struct {
		name        string
		combination Combination
		want        error
	}{
		{name: "empty", combination: Combination{ID: "empty", Strategy: "fallback"}, want: ErrEmptyCombo},
		{name: "unknown strategy", combination: Combination{ID: "unknown", Members: []string{"native-model"}, Strategy: "weighted"}},
		{name: "duplicate member", combination: Combination{ID: "duplicate", Members: []string{"native-model", "fixture:native-model"}, Strategy: "fallback"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := b.Build(context.Background(), StaticSource{CombinationList: []Combination{tc.combination}})
			if err == nil || (tc.want != nil && !errors.Is(err, tc.want)) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestBuilderRequiresQualifiedAmbiguousMembersAndCommonSurface(t *testing.T) {
	registry := testRegistry(t)
	registry.Register(adapters.NewOpenAIAdapter(adapters.OpenAIAdapterConfig{
		ID: "other", DisplayName: "Other", BaseURL: "http://127.0.0.1",
		Surfaces: []providers.Surface{providers.SurfaceAnthropicMessages},
		Models:   []providers.ProviderModel{providers.Model("native-model", "Other", nil), providers.Model("other-model", "Other Model", nil)},
	}))
	b, _ := NewBuilder(registry)
	_, err := b.Build(context.Background(), StaticSource{CombinationList: []Combination{{ID: "ambiguous", Members: []string{"native-model"}, Strategy: "fallback"}}})
	if !errors.Is(err, ErrAmbiguousModel) {
		t.Fatalf("ambiguous error = %v", err)
	}
	_, err = b.Build(context.Background(), StaticSource{CombinationList: []Combination{{ID: "surface", Members: []string{"fixture:native-model", "other:other-model"}, Strategy: "fallback"}}})
	if !errors.Is(err, ErrSurfaceMismatch) {
		t.Fatalf("surface error = %v", err)
	}
}

type mutableSource struct {
	source StaticSource
	err    error
}

func (s *mutableSource) Load(ctx context.Context) ([]Alias, []Combination, uint64, error) {
	if s.err != nil {
		return nil, nil, 0, s.err
	}
	return s.source.Load(ctx)
}

func TestStoreRetainsBoundedStaleSnapshotAndExposesDegradedState(t *testing.T) {
	now := time.Unix(100, 0)
	builder, _ := NewBuilder(testRegistry(t))
	source := &mutableSource{source: StaticSource{Gen: 7}}
	store, err := NewStore(context.Background(), builder, source, StoreConfig{RefreshTTL: time.Second, MaxStale: 5 * time.Second, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	source.err = errors.New("refresh unavailable")
	now = now.Add(2 * time.Second)
	snapshot, status, err := store.Current(context.Background())
	if err != nil || snapshot.Generation != 7 || !status.Degraded || status.Diagnostic == "" {
		t.Fatalf("snapshot=%#v status=%#v err=%v", snapshot, status, err)
	}
	now = now.Add(5 * time.Second)
	_, status, err = store.Current(context.Background())
	if !errors.Is(err, ErrStaleSnapshot) || !status.Degraded {
		t.Fatalf("status=%#v err=%v", status, err)
	}
}

func TestCatalogHelpersAndWrappers(t *testing.T) {
	t.Run("nil capability error", func(t *testing.T) {
		var err *CapabilityError
		if got := err.Error(); got != "catalog: capability mismatch" {
			t.Fatalf("Error() = %q", got)
		}
	})
	t.Run("resolve errors", func(t *testing.T) {
		var snapshot *Snapshot
		if !errors.Is(func() error { _, err := snapshot.Resolve("x"); return err }(), ErrUnknownModel) {
			t.Fatal("nil snapshot should reject Resolve")
		}
		snapshot = &Snapshot{Models: map[string]Model{}}
		if !errors.Is(func() error { _, err := snapshot.Resolve("x"); return err }(), ErrUnknownModel) {
			t.Fatal("unknown model should reject Resolve")
		}
	})
	t.Run("dedupe and mappings", func(t *testing.T) {
		req := normalizeRequirements(FeatureRequirements{
			Hard:      []FeatureRequirement{"", FeatureVision, FeatureVision, FeatureAudio},
			ToolKinds: []transforms.ToolKind{"", transforms.ToolKindMCP, transforms.ToolKindFunction, transforms.ToolKindMCP},
		})
		if len(req.Hard) != 2 || req.Hard[0] != FeatureAudio || req.Hard[1] != FeatureVision {
			t.Fatalf("normalized hard = %#v", req.Hard)
		}
		if len(req.ToolKinds) != 2 || req.ToolKinds[0] != transforms.ToolKindFunction || req.ToolKinds[1] != transforms.ToolKindMCP {
			t.Fatalf("normalized tools = %#v", req.ToolKinds)
		}
		for _, tc := range []struct {
			in   transforms.ToolKind
			want providers.ToolKind
		}{
			{transforms.ToolKindFunction, providers.ToolFunction},
			{transforms.ToolKindCustom, providers.ToolCustom},
			{transforms.ToolKindComputer, providers.ToolComputer},
			{transforms.ToolKindHosted, providers.ToolHosted},
			{transforms.ToolKindServer, providers.ToolServer},
			{transforms.ToolKindWebSearch, providers.ToolWebSearch},
			{transforms.ToolKindImage, providers.ToolImage},
			{transforms.ToolKindMCP, providers.ToolMCP},
			{"unknown", providers.ToolProviderNative},
		} {
			if got := providerToolKind(tc.in); got != tc.want {
				t.Errorf("providerToolKind(%q) = %q, want %q", tc.in, got, tc.want)
			}
		}
	})
	t.Run("mismatch codes", func(t *testing.T) {
		for _, tc := range []struct {
			feature FeatureRequirement
			want    string
		}{
			{FeatureToolDeclaration, "capability.tool_unsupported"},
			{FeatureToolCall, "capability.tool_unsupported"},
			{FeatureToolResult, "capability.tool_unsupported"},
			{FeatureNativeTool, "capability.tool_unsupported"},
			{FeatureVision, "capability.reference_unsupported"},
			{FeatureAudio, "capability.reference_unsupported"},
			{FeatureFile, "capability.reference_unsupported"},
			{FeatureDocument, "capability.reference_unsupported"},
			{FeaturePDF, "capability.reference_unsupported"},
			{FeatureCompactionV1, "capability.compaction_unsupported"},
			{FeatureCompactionV2, "capability.compaction_unsupported"},
			{FeatureStructuredOutput, "capability.feature_unsupported"},
		} {
			if got := featureMismatchCode(tc.feature); got != tc.want {
				t.Errorf("featureMismatchCode(%q) = %q, want %q", tc.feature, got, tc.want)
			}
		}
	})
}

func TestCatalogPlanningWrappersAndFeatureBranches(t *testing.T) {
	builder, err := NewBuilder(testRegistry(t))
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := builder.Build(context.Background(), StaticSource{Gen: 11})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := snapshot.PlanWithRequirements("native-model", contracts.SurfaceOpenAIChat, transforms.OperationGenerate, FeatureRequirements{})
	if err != nil || len(plan.Members) != 1 {
		t.Fatalf("PlanWithRequirements() = %#v, %v", plan, err)
	}
	if _, err := snapshot.PlanCanonical("native-model", nil); !errors.Is(err, ErrUnknownModel) {
		t.Fatalf("nil canonical request error = %v", err)
	}
	req := &transforms.NormalizedRequest{Model: "native-model", Source: contracts.SurfaceOpenAIChat, Reasoning: transforms.ReasoningDefault}
	plan, err = snapshot.PlanCanonical("native-model", req)
	if err != nil || plan.Operation != transforms.OperationGenerate {
		t.Fatalf("PlanCanonical() = %#v, %v", plan, err)
	}

	model := Model{Capabilities: providers.ProviderCaps{Compatibility: providers.CompatibilityPolicy{
		Tools:     providers.ToolPolicy{ProviderNative: true},
		Reasoning: providers.ReasoningPolicy{Enabled: true},
	}}}
	requirements := FeatureRequirements{}
	for _, feature := range []FeatureRequirement{
		FeatureStructuredOutput, FeatureContinuation, FeatureReasoningHistory,
		FeatureVision, FeatureAudio, FeatureFile, FeatureDocument, FeaturePDF,
		FeatureToolDeclaration, FeatureToolCall, FeatureToolResult, FeatureNativeTool,
	} {
		got := modelSupportsFeature(model, providers.SurfaceOpenAIChat, contracts.SurfaceOpenAIChat, feature, requirements)
		if feature == FeatureStructuredOutput || feature == FeatureContinuation || feature == FeatureReasoningHistory || feature == FeatureNativeTool {
			if !got {
				t.Errorf("modelSupportsFeature(%q) = false, want true", feature)
			}
		}
	}
	if modelSupportsFeature(model, providers.SurfaceOpenAIChat, contracts.SurfaceOpenAIChat, FeatureCompactionV1, requirements) {
		t.Fatal("compaction should require responses target")
	}
	if !modelSupportsFeature(model, providers.SurfaceOpenAIChat, contracts.SurfaceOpenAIChat, "future", requirements) {
		t.Fatal("unknown feature should be accepted")
	}
}

func TestCatalogMemberRankAndSurfaceStrings(t *testing.T) {
	if got := surfaceStrings([]providers.Surface{providers.SurfaceOpenAIChat, providers.SurfaceOpenAIResponses}); len(got) != 2 || got[0] != string(providers.SurfaceOpenAIChat) {
		t.Fatalf("surfaceStrings = %#v", got)
	}
	member := RouteMember{ProviderID: "fixture", ClientModelID: "native-model", SourceSurface: contracts.SurfaceOpenAIChat, TargetSurface: providers.SurfaceOpenAIChat}
	snapshot := &Snapshot{Models: map[string]Model{"fixture:native-model": {}}}
	if got := memberRank(snapshot, member, FeatureRequirements{}); got != 1000 {
		t.Fatalf("native rank = %d", got)
	}
	member.TargetSurface = providers.SurfaceOpenAIResponses
	if got := memberRank(nil, member, FeatureRequirements{}); got != 2000 {
		t.Fatalf("translated rank = %d", got)
	}
}
