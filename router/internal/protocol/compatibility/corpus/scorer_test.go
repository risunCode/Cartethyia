package corpus

import (
	"strings"
	"testing"

	compatibility "github.com/cartethyia/daemon/internal/protocol"
)

func TestScoreWeightedTierBreakdownAndMatrixDimensions(t *testing.T) {
	first := testLoadedFixture("claude-tier0", 0, 10, compatibility.ProfileClaudeCode, SurfaceAnthropic, SurfaceAnthropic)
	second := testLoadedFixture("codex-tier1", 1, 90, compatibility.ProfileCodexCLI, SurfaceOpenAIChat, SurfaceOpenAIResponses)
	corpus := testCorpus(first, second)
	results := map[string]ScenarioResult{
		first.Spec.ID:  matchingResult(first),
		second.Spec.ID: matchingResult(second),
	}

	report, err := Score(corpus, results)
	if err != nil {
		t.Fatalf("Score() error = %v", err)
	}
	if !report.Passed || !report.Tier0Passed {
		t.Fatalf("expected passing corpus, got passed=%v tier0=%v", report.Passed, report.Tier0Passed)
	}
	if report.Tier1.ScoreBasisPoints != 10000 || report.Tier1.PassedWeight != 90 {
		t.Fatalf("unexpected Tier-1 score: %+v", report.Tier1)
	}
	if report.Total.TotalWeight != 100 || report.Total.PassedWeight != 100 {
		t.Fatalf("unexpected total score: %+v", report.Total)
	}
	if report.ByProfile[string(compatibility.ProfileClaudeCode)].Passed != 1 {
		t.Fatalf("missing profile breakdown: %+v", report.ByProfile)
	}
	if report.BySourceSurface[string(SurfaceOpenAIChat)].TotalWeight != 90 {
		t.Fatalf("missing source-surface breakdown: %+v", report.BySourceSurface)
	}
	if report.ByTargetSurface[string(SurfaceOpenAIResponses)].PassedWeight != 90 {
		t.Fatalf("missing target-surface breakdown: %+v", report.ByTargetSurface)
	}
	if report.ByProvider["synthetic-provider"].TotalWeight != 100 {
		t.Fatalf("missing provider breakdown: %+v", report.ByProvider)
	}
	if report.ByFeature[string(FeatureText)].TotalWeight != 100 {
		t.Fatalf("missing feature breakdown: %+v", report.ByFeature)
	}
}

func TestScoreTierZeroGateIndependentOfWeightedTierOne(t *testing.T) {
	critical := testLoadedFixture("critical-tool", 0, 1, compatibility.ProfileUnknownStandard, SurfaceOpenAIResponses, SurfaceOpenAIResponses)
	nonCritical := testLoadedFixture("ordinary-text", 1, 100, compatibility.ProfileUnknownStandard, SurfaceOpenAIChat, SurfaceOpenAIChat)
	corpus := testCorpus(critical, nonCritical)
	results := map[string]ScenarioResult{
		critical.Spec.ID:    matchingResult(critical),
		nonCritical.Spec.ID: matchingResult(nonCritical),
	}
	broken := results[critical.Spec.ID]
	broken.Terminal.Status = "error"
	broken.Terminal.ErrorCode = "terminal.invalid"
	results[critical.Spec.ID] = broken

	report, err := Score(corpus, results)
	if err != nil {
		t.Fatalf("Score() error = %v", err)
	}
	if report.Tier1.ScoreBasisPoints != 10000 {
		t.Fatalf("Tier-1 should remain green: %+v", report.Tier1)
	}
	if report.Tier0Passed || report.Passed {
		t.Fatalf("Tier-0 failure must block rollout: %+v", report)
	}
	if len(report.Failures) != 1 || report.Failures[0].Code != CodeTerminalMismatch {
		t.Fatalf("unexpected failure report: %+v", report.Failures)
	}
}

func TestScoreChecksResultVersionsAndBoundsRedactedTrace(t *testing.T) {
	fixture := testLoadedFixture("versioned-fixture", 1, 1, compatibility.ProfileOpenAICompatible, SurfaceOpenAIChat, SurfaceOpenAIChat)
	corpus := testCorpus(fixture)
	result := matchingResult(fixture)
	result.SchemaVersion = CurrentSchemaVersion
	result.CorpusGeneration = corpus.Manifest.Generation
	result.ContentGeneration = fixture.Spec.ContentGeneration
	result.Dispositions = []DispositionExpectation{{
		SourcePath: "/messages/0/" + strings.Repeat("long-path", 100),
		TargetPath: "/messages/0/content/0",
		Action:     DispositionStripNonSemantic,
		RuleID:     "redaction-rule",
	}}

	report, err := ScoreWithOptions(corpus, map[string]ScenarioResult{fixture.Spec.ID: result}, ScoreOptions{
		ResultSchemaVersion:  CurrentSchemaVersion,
		ResultGeneration:     corpus.Manifest.Generation + 1,
		RequireResultVersion: true,
	})
	if err != nil {
		t.Fatalf("ScoreWithOptions() error = %v", err)
	}
	if len(report.Failures) != 1 || report.Failures[0].Code != CodeGenerationMismatch {
		t.Fatalf("expected generation mismatch, got %+v", report.Failures)
	}

	report, err = Score(corpus, map[string]ScenarioResult{fixture.Spec.ID: result})
	if err != nil {
		t.Fatalf("Score() error = %v", err)
	}
	if len(report.Failures) != 1 || report.Failures[0].Code != CodeDispositionMismatch {
		t.Fatalf("expected disposition mismatch, got %+v", report.Failures)
	}
	if len(report.Failures[0].DispositionTrace) != 1 {
		t.Fatalf("expected bounded disposition trace: %+v", report.Failures[0])
	}
	if len(report.Failures[0].DispositionTrace[0].SourcePath) > MaxPathBytes {
		t.Fatalf("trace path exceeded bound: %d", len(report.Failures[0].DispositionTrace[0].SourcePath))
	}
	if strings.Contains(report.Failures[0].Mismatch, "long-path") {
		t.Fatalf("failure mismatch leaked fixture content: %+v", report.Failures[0])
	}
	encoded, err := report.MarshalStable()
	if err != nil {
		t.Fatalf("MarshalStable() error = %v", err)
	}
	if strings.Contains(string(encoded), "synthetic request") {
		t.Fatalf("machine report leaked fixture content: %s", encoded)
	}
}

func TestSemanticDigestIgnoresJSONFormattingAndIncludesCompactionVersion(t *testing.T) {
	first := Semantic{
		Operation: Operation{Kind: OperationRemoteCompaction, CompactionVersion: CompactionV1},
		Messages:  []SemanticMessage{{Role: "user", Content: []SemanticContent{{Kind: "structured-output", StructuredJSON: []byte(`{"b":2,"a":1}`)}}}},
		Terminal:  TerminalExpectation{Status: "success", Event: "response.completed", Sequence: []string{"response.created", "response.completed"}},
	}
	second := first
	second.Messages = append([]SemanticMessage(nil), first.Messages...)
	second.Messages[0].Content = append([]SemanticContent(nil), first.Messages[0].Content...)
	second.Messages[0].Content[0].StructuredJSON = []byte(`{ "a": 1.0, "b": 2 }`)
	left, err := SemanticDigest(first)
	if err != nil {
		t.Fatalf("SemanticDigest(first) error = %v", err)
	}
	right, err := SemanticDigest(second)
	if err != nil {
		t.Fatalf("SemanticDigest(second) error = %v", err)
	}
	if left != right {
		t.Fatalf("formatting-only JSON change altered digest: %s != %s", left, right)
	}
	second.Operation.CompactionVersion = CompactionV2
	changed, err := SemanticDigest(second)
	if err != nil {
		t.Fatalf("SemanticDigest(changed) error = %v", err)
	}
	if left == changed {
		t.Fatal("compaction version change did not alter semantic digest")
	}
}

func TestValidateGenerationRequiresExplicitBump(t *testing.T) {
	fixture := testLoadedFixture("generation-fixture", 1, 1, compatibility.ProfileUnknownStandard, SurfaceOpenAIChat, SurfaceOpenAIChat)
	previous := testCorpus(fixture).Manifest
	changed := previous
	changed.TargetBasisPoints++
	if err := ValidateGeneration(previous, changed); CodeOf(err) != CodeGenerationRequired {
		t.Fatalf("score-affecting change without generation bump: code=%s err=%v", CodeOf(err), err)
	}
	changed.Generation++
	if err := ValidateGeneration(previous, changed); err != nil {
		t.Fatalf("generation bump rejected: %v", err)
	}
	rollback := previous
	rollback.Generation--
	if err := ValidateGeneration(previous, rollback); CodeOf(err) != CodeGenerationMismatch {
		t.Fatalf("generation rollback: code=%s err=%v", CodeOf(err), err)
	}
}

func testCorpus(fixtures ...LoadedFixture) *Corpus {
	manifest := Manifest{
		SchemaVersion:     CurrentSchemaVersion,
		Generation:        7,
		TargetBasisPoints: 9500,
		Fixtures:          fixtureSpecs(fixtures),
	}
	digest, err := ManifestDigest(manifest)
	if err != nil {
		panic(err)
	}
	manifest.CorpusDigest = digest
	return &Corpus{Manifest: manifest, Fixtures: fixtures}
}

func fixtureSpecs(fixtures []LoadedFixture) []FixtureSpec {
	out := make([]FixtureSpec, len(fixtures))
	for i := range fixtures {
		out[i] = fixtures[i].Spec
	}
	return out
}

func testLoadedFixture(id string, tier, weight int, profile compatibility.ClientProfileID, source, target Surface) LoadedFixture {
	semantic := Semantic{
		Operation: Operation{Kind: OperationGenerate},
		Messages:  []SemanticMessage{{Role: "user", Content: []SemanticContent{{Kind: "text", Text: "synthetic request"}}}},
		Terminal:  TerminalExpectation{Status: "success", Event: "response.completed", StopReason: "stop", Sequence: []string{"response.created", "response.completed"}},
	}
	digest, err := SemanticDigest(semantic)
	if err != nil {
		panic(err)
	}
	request := []byte(`{"model":"synthetic-model"}`)
	contentDigest, err := DigestJSON(request)
	if err != nil {
		panic(err)
	}
	spec := FixtureSpec{
		ID:                id,
		ContentGeneration: 1,
		File:              id + ".json",
		ContentDigest:     contentDigest,
		Profile:           profile,
		Operation:         semantic.Operation,
		SourceSurface:     source,
		Target:            Target{Provider: "synthetic-provider", Surface: target, Model: "synthetic-model", Policy: ProviderModelPolicy{ID: "synthetic-policy", Generation: 1}},
		ComparisonMode:    ComparisonSemantic,
		Features:          []Feature{FeatureText},
		Weight:            weight,
		Tier:              tier,
		Expected:          Expected{SemanticDigest: digest, Dispositions: []DispositionExpectation{{SourcePath: "/messages/0/content/0", Action: DispositionPreserve}}, Terminal: semantic.Terminal},
	}
	return LoadedFixture{Spec: spec, Fixture: Fixture{ID: id, ContentGeneration: 1, Request: request, ExpectedSemantic: semantic}}
}

func matchingResult(fixture LoadedFixture) ScenarioResult {
	return ScenarioResult{Semantic: fixture.Fixture.ExpectedSemantic, Dispositions: fixture.Spec.Expected.Dispositions, Terminal: fixture.Spec.Expected.Terminal}
}
