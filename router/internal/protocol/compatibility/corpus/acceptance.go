package corpus

import (
	"encoding/json"
	"strings"
)

// AcceptanceEvidence contains aggregate evidence produced by an offline
// fixture evaluator. It deliberately has no request, response, cache-key, or
// credential fields. A zero value is safe, but an eligible provider-cache
// fixture count must be supplied for the provider-hit gate to pass.
type AcceptanceEvidence struct {
	AvoidablePreparedCandidateErrors int
	FalseCacheReuse                  int
	CrossTenantCacheReuse            int
	PlaintextCacheValues             int
	PostOneHourCacheHits             int
	ResponseCacheFalseReuse          int
	ContentCacheFalseReuse           int
	ResponseCacheProviderCalls       int
	EligibleProviderCacheFixtures    int
	ProviderCacheHitFixtures         int
}

type AcceptanceGate struct {
	Passed     bool   `json:"passed"`
	Value      int    `json:"value"`
	Target     int    `json:"target"`
	Comparator string `json:"comparator"`
}

type AcceptanceFailure struct {
	Gate      string `json:"gate"`
	FixtureID string `json:"fixture_id,omitempty"`
	Reason    string `json:"reason"`
}

// AcceptanceReport is the redacted, deterministic acceptance result layered on
// top of the canonical corpus score. It is intentionally separate from
// production metrics: matrix acceptance is an offline rollout gate.
type AcceptanceReport struct {
	Passed       bool                      `json:"passed"`
	Weighted     AcceptanceGate            `json:"weighted_score"`
	Tier0        AcceptanceGate            `json:"tier0"`
	Gates        map[string]AcceptanceGate `json:"gates"`
	Failures     []AcceptanceFailure       `json:"failures,omitempty"`
	FailureCount int                       `json:"failure_count"`
}

// MarshalStable emits redacted machine-readable acceptance output. Go's JSON
// encoder sorts map keys while gate/failure slices retain their fixed order.
func (report AcceptanceReport) MarshalStable() ([]byte, error) {
	return json.Marshal(report)
}

// CheckAcceptance applies the task-23 rollout gates to one scored corpus. The
// score remains authoritative for weighted and Tier-0 results; this function
// only adds the invariant and cache evidence gates. Failure order follows
// corpus fixture order and the fixed gate order below.
func CheckAcceptance(corpus *Corpus, score ScoreReport, evidence AcceptanceEvidence) AcceptanceReport {
	result := AcceptanceReport{Gates: make(map[string]AcceptanceGate)}
	result.Weighted = AcceptanceGate{Passed: score.Tier1.ScoreBasisPoints >= score.TargetBasisPoints, Value: score.Tier1.ScoreBasisPoints, Target: score.TargetBasisPoints, Comparator: ">="}
	result.Tier0 = AcceptanceGate{Passed: score.Tier0Passed && score.Tier0.Scenarios > 0 && score.Tier0.ScoreBasisPoints == 10000, Value: score.Tier0.ScoreBasisPoints, Target: 10000, Comparator: "="}
	result.Gates["avoidable-prepared-candidate-errors"] = zeroGate(evidence.AvoidablePreparedCandidateErrors)
	result.Gates["false-cache-reuse"] = zeroGate(evidence.FalseCacheReuse)
	result.Gates["cross-tenant-cache-reuse"] = zeroGate(evidence.CrossTenantCacheReuse)
	result.Gates["plaintext-cache-values"] = zeroGate(evidence.PlaintextCacheValues)
	result.Gates["post-one-hour-cache-hits"] = zeroGate(evidence.PostOneHourCacheHits)
	result.Gates["response-cache-false-reuse"] = zeroGate(evidence.ResponseCacheFalseReuse)
	result.Gates["content-cache-false-reuse"] = zeroGate(evidence.ContentCacheFalseReuse)
	result.Gates["response-cache-provider-calls"] = zeroGate(evidence.ResponseCacheProviderCalls)
	providerRatio := 0
	if evidence.EligibleProviderCacheFixtures > 0 {
		providerRatio = evidence.ProviderCacheHitFixtures * 10000 / evidence.EligibleProviderCacheFixtures
	}
	result.Gates["provider-cache-hit-ratio"] = AcceptanceGate{Passed: evidence.EligibleProviderCacheFixtures > 0 && providerRatio >= 9000, Value: providerRatio, Target: 9000, Comparator: ">="}

	failed := make(map[string]struct{}, len(score.Failures))
	for _, failure := range score.Failures {
		failed[failure.FixtureID] = struct{}{}
	}
	for _, group := range acceptanceFixtureGroups {
		if corpus == nil {
			result.Gates[group.Name] = AcceptanceGate{Passed: false, Target: 1, Comparator: "="}
			result.Failures = append(result.Failures, AcceptanceFailure{Gate: group.Name, Reason: "corpus unavailable"})
			continue
		}
		matched := 0
		failedCount := 0
		for _, fixture := range corpus.Fixtures {
			if !group.Match(fixture.Spec) {
				continue
			}
			matched++
			if _, ok := failed[fixture.Spec.ID]; ok || score.FailuresTruncated {
				failedCount++
				result.Failures = append(result.Failures, AcceptanceFailure{Gate: group.Name, FixtureID: fixture.Spec.ID, Reason: "fixture failed"})
			}
		}
		result.Gates[group.Name] = AcceptanceGate{Passed: matched > 0 && failedCount == 0, Value: matched - failedCount, Target: matched, Comparator: "="}
		if matched == 0 {
			result.Failures = append(result.Failures, AcceptanceFailure{Gate: group.Name, Reason: "approved fixture is missing"})
		}
	}
	if compaction, ok := result.Gates["compaction"]; ok {
		result.Gates["compaction-item-cardinality"] = compaction
	}
	for _, name := range []string{"weighted-score", "tier0", "compaction", "compaction-item-cardinality", "context-management", "tool-occurrence-pairing", "media-document-semantics", "specific-capability-errors", "avoidable-prepared-candidate-errors", "false-cache-reuse", "cross-tenant-cache-reuse", "plaintext-cache-values", "post-one-hour-cache-hits", "response-cache-false-reuse", "content-cache-false-reuse", "response-cache-provider-calls", "provider-cache-hit-ratio"} {
		gate := result.Weighted
		if name == "tier0" {
			gate = result.Tier0
		} else if value, ok := result.Gates[name]; ok {
			gate = value
		}
		if !gate.Passed {
			result.Failures = append(result.Failures, AcceptanceFailure{Gate: name, Reason: "gate failed"})
		}
	}
	result.FailureCount = len(result.Failures)
	result.Passed = result.FailureCount == 0
	return result
}

func zeroGate(value int) AcceptanceGate {
	return AcceptanceGate{Passed: value == 0, Value: value, Target: 0, Comparator: "="}
}

type acceptanceFixtureGroup struct {
	Name  string
	Match func(FixtureSpec) bool
}

var acceptanceFixtureGroups = []acceptanceFixtureGroup{
	{Name: "compaction", Match: func(spec FixtureSpec) bool { return spec.Operation.Kind == OperationRemoteCompaction }},
	{Name: "context-management", Match: func(spec FixtureSpec) bool { return hasFeature(spec, FeatureContextManagement) }},
	{Name: "tool-occurrence-pairing", Match: func(spec FixtureSpec) bool {
		return hasAnyFeature(spec, FeatureToolCall, FeatureToolResult, FeatureParallelTools)
	}},
	{Name: "media-document-semantics", Match: func(spec FixtureSpec) bool {
		return hasAnyFeature(spec, FeatureImage, FeatureAudio, FeatureFile, FeaturePDF)
	}},
	{Name: "specific-capability-errors", Match: func(spec FixtureSpec) bool { return strings.HasPrefix(spec.Expected.Terminal.ErrorCode, "capability.") }},
}

func hasFeature(spec FixtureSpec, wanted Feature) bool {
	for _, feature := range spec.Features {
		if feature == wanted {
			return true
		}
	}
	return false
}

func hasAnyFeature(spec FixtureSpec, wanted ...Feature) bool {
	for _, feature := range wanted {
		if hasFeature(spec, feature) {
			return true
		}
	}
	return false
}
