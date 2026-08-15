package corpus

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/compatibility"
)

func TestCheckAcceptanceRequiresProviderCacheEvidence(t *testing.T) {
	fixture := testLoadedFixture("cache-gate", 1, 1, compatibility.ProfileUnknownStandard, SurfaceOpenAIChat, SurfaceOpenAIChat)
	fixture.Spec.Features = []Feature{FeatureText}
	corpus := testCorpus(fixture)
	score, err := Score(corpus, map[string]ScenarioResult{fixture.Spec.ID: matchingResult(fixture)})
	if err != nil {
		t.Fatal(err)
	}
	acceptance := CheckAcceptance(corpus, score, AcceptanceEvidence{})
	if acceptance.Passed || acceptance.Gates["provider-cache-hit-ratio"].Passed {
		t.Fatalf("missing eligible provider-cache fixtures must fail: %+v", acceptance)
	}
}

func TestCheckAcceptanceCoversCriticalFixtureGroupsWithoutContent(t *testing.T) {
	fixture := testLoadedFixture("critical-compaction", 0, 1, compatibility.ProfileCodexCLI, SurfaceOpenAIResponses, SurfaceOpenAIResponses)
	fixture.Spec.Operation = Operation{Kind: OperationRemoteCompaction, CompactionVersion: CompactionV1}
	fixture.Spec.Features = []Feature{FeatureRemoteCompactionV1, FeatureToolCall, FeatureImage}
	fixture.Spec.Expected.Terminal.ErrorCode = "capability.remote_compaction_v1_unsupported"
	fixture.Fixture.ExpectedSemantic.Operation = Operation{Kind: OperationRemoteCompaction, CompactionVersion: CompactionV1}
	ordinary := testLoadedFixture("ordinary-text", 1, 1, compatibility.ProfileUnknownStandard, SurfaceOpenAIChat, SurfaceOpenAIChat)
	corpus := testCorpus(fixture, ordinary)
	score, err := Score(corpus, map[string]ScenarioResult{fixture.Spec.ID: matchingResult(fixture), ordinary.Spec.ID: matchingResult(ordinary)})
	if err != nil {
		t.Fatal(err)
	}
	acceptance := CheckAcceptance(corpus, score, AcceptanceEvidence{
		EligibleProviderCacheFixtures: 1,
		ProviderCacheHitFixtures:      1,
	})
	if acceptance.FailureCount == 0 {
		// The synthetic fixture intentionally lacks context-management and
		// capability-error siblings; missing approved groups must be visible.
		t.Fatal("expected missing critical groups to be reported")
	}
	encoded, err := json.Marshal(acceptance)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "synthetic request") || strings.Contains(string(encoded), "corpus_digest") {
		t.Fatalf("acceptance report leaked request/corpus data: %s", encoded)
	}
}
