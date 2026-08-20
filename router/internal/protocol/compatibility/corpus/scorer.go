package corpus

import (
	"encoding/json"
	"fmt"
	"strconv"
)

const (
	// MaxScoreFailures bounds operator-visible failure details even when every
	// scenario fails. FailureCount remains the complete count.
	MaxScoreFailures = 128
	// MaxDispositionTrace bounds the field-action trace retained per failure.
	MaxDispositionTrace = 32
)

// ScenarioResult is the redacted semantic result produced by an offline
// compatibility evaluator. It intentionally contains no request/response
// bodies; JSON values are retained only inside Semantic for digest comparison.
type ScenarioResult struct {
	SchemaVersion     int                      `json:"schema_version,omitempty"`
	CorpusGeneration  int                      `json:"corpus_generation,omitempty"`
	ContentGeneration int                      `json:"content_generation,omitempty"`
	Semantic          Semantic                 `json:"semantic"`
	Dispositions      []DispositionExpectation `json:"dispositions"`
	Terminal          TerminalExpectation      `json:"terminal"`
}

// Evaluator is deliberately an offline boundary. Runtime translation and
// provider calls do not belong in the corpus package.
type Evaluator func(LoadedFixture) (ScenarioResult, error)

// ScoreOptions controls version checks for externally produced results. Zero
// values preserve compatibility with simple semantic-only test evaluators;
// non-zero values make stale evaluator output a deterministic failure.
type ScoreOptions struct {
	ResultSchemaVersion  int
	ResultGeneration     int
	RequireResultVersion bool
}

type Breakdown struct {
	Scenarios        int `json:"scenarios"`
	Passed           int `json:"passed"`
	TotalWeight      int `json:"total_weight"`
	PassedWeight     int `json:"passed_weight"`
	ScoreBasisPoints int `json:"score_basis_points"`
}

type Failure struct {
	FixtureID        string             `json:"fixture_id"`
	Tier             int                `json:"tier"`
	Code             ErrorCode          `json:"code"`
	Mismatch         string             `json:"mismatch"`
	DispositionTrace []DispositionTrace `json:"disposition_trace,omitempty"`
}

// DispositionTrace contains only bounded paths, actions, and rule IDs. It
// never includes a field value or fixture body.
type DispositionTrace struct {
	SourcePath string            `json:"source_path"`
	TargetPath string            `json:"target_path,omitempty"`
	Action     DispositionAction `json:"action"`
	RuleID     string            `json:"rule_id,omitempty"`
}

type ScoreReport struct {
	SchemaVersion     int                  `json:"schema_version"`
	CorpusGeneration  int                  `json:"corpus_generation"`
	CorpusDigest      string               `json:"corpus_digest"`
	TargetBasisPoints int                  `json:"target_basis_points"`
	Passed            bool                 `json:"passed"`
	Tier0Passed       bool                 `json:"tier0_passed"`
	Tier1             Breakdown            `json:"tier1"`
	Tier0             Breakdown            `json:"tier0"`
	Total             Breakdown            `json:"total"`
	ByProfile         map[string]Breakdown `json:"by_profile"`
	BySourceSurface   map[string]Breakdown `json:"by_source_surface"`
	ByTargetSurface   map[string]Breakdown `json:"by_target_surface"`
	ByProvider        map[string]Breakdown `json:"by_provider"`
	ByFeature         map[string]Breakdown `json:"by_feature"`
	Failures          []Failure            `json:"failures,omitempty"`
	FailureCount      int                  `json:"failure_count"`
	FailuresTruncated bool                 `json:"failures_truncated,omitempty"`
	FailureGroups     map[string]int       `json:"failure_groups,omitempty"`
}

// Score compares supplied results with every loaded fixture. Missing results
// are failures, not an evaluator error, so matrix runs remain complete and
// report all bounded fixture IDs. Invalid corpus/result input returns a typed
// error before scoring.
func Score(corpus *Corpus, results map[string]ScenarioResult) (ScoreReport, error) {
	return ScoreWithOptions(corpus, results, ScoreOptions{})
}

func ScoreWithOptions(corpus *Corpus, results map[string]ScenarioResult, options ScoreOptions) (ScoreReport, error) {
	if corpus == nil {
		return ScoreReport{}, corpusError(CodeInvalidInput, StageScore, "corpus", nil)
	}
	if results == nil {
		return ScoreReport{}, corpusError(CodeInvalidInput, StageScore, "results", nil)
	}
	if corpus.Manifest.SchemaVersion != CurrentSchemaVersion || corpus.Manifest.Generation < 1 {
		return ScoreReport{}, corpusError(CodeManifestInvalid, StageScore, "manifest.version", nil)
	}
	if err := ValidateManifest(corpus.Manifest); err != nil {
		return ScoreReport{}, err
	}
	if err := validateScoreCorpus(*corpus); err != nil {
		return ScoreReport{}, err
	}
	if options.ResultSchemaVersion < 0 || options.ResultGeneration < 0 {
		return ScoreReport{}, corpusError(CodeInvalidInput, StageScore, "result.version", nil)
	}

	report := newScoreReport(corpus.Manifest)
	for i := range corpus.Fixtures {
		loaded := corpus.Fixtures[i]
		result, ok := results[loaded.Spec.ID]
		passed, failure := compareResult(loaded, result, ok, options)
		recordScenario(&report, loaded.Spec, passed)
		if !passed {
			report.FailureCount++
			report.FailureGroups[string(failure.Code)]++
			if len(report.Failures) < MaxScoreFailures {
				report.Failures = append(report.Failures, failure)
			} else {
				report.FailuresTruncated = true
			}
		}
	}
	finalizeBreakdowns(&report)
	report.Tier0Passed = report.Tier0.Scenarios > 0 && report.Tier0.Scenarios == report.Tier0.Passed
	report.Passed = report.Tier0Passed && report.Tier1.ScoreBasisPoints >= report.TargetBasisPoints
	return report, nil
}

func validateScoreCorpus(corpus Corpus) error {
	if corpus.Manifest.TargetBasisPoints < 1 || corpus.Manifest.TargetBasisPoints > 10000 ||
		len(corpus.Fixtures) == 0 || len(corpus.Fixtures) > MaxScenarios ||
		len(corpus.Manifest.Fixtures) != len(corpus.Fixtures) {
		return corpusError(CodeManifestInvalid, StageScore, "manifest.bounds", nil)
	}
	seen := make(map[string]struct{}, len(corpus.Fixtures))
	for i := range corpus.Fixtures {
		spec := corpus.Fixtures[i].Spec
		if !validID(spec.ID) || spec.Weight < 1 || spec.Weight > MaxWeight || (spec.Tier != 0 && spec.Tier != 1) {
			return corpusError(CodeManifestInvalid, StageScore, "fixtures["+strconv.Itoa(i)+"]", nil)
		}
		manifestSpec := corpus.Manifest.Fixtures[i]
		if manifestSpec.ID != spec.ID || manifestSpec.ContentGeneration != spec.ContentGeneration {
			return corpusError(CodeGenerationMismatch, StageScore, "fixtures["+strconv.Itoa(i)+"]", nil)
		}
		if _, exists := seen[spec.ID]; exists {
			return corpusError(CodeManifestInvalid, StageScore, "fixtures.id", nil)
		}
		seen[spec.ID] = struct{}{}
	}
	return nil
}

// ScoreWithEvaluator runs a bounded offline evaluator in fixture order. An
// evaluator failure is represented as a redacted fixture failure and does not
// leak the evaluator's error text.
func ScoreWithEvaluator(corpus *Corpus, evaluator Evaluator) (ScoreReport, error) {
	if evaluator == nil {
		return ScoreReport{}, corpusError(CodeInvalidInput, StageScore, "evaluator", nil)
	}
	if corpus == nil {
		return ScoreReport{}, corpusError(CodeInvalidInput, StageScore, "corpus", nil)
	}
	results := make(map[string]ScenarioResult, len(corpus.Fixtures))
	failed := make(map[string]bool, len(corpus.Fixtures))
	for i := range corpus.Fixtures {
		loaded := corpus.Fixtures[i]
		result, err := evaluator(loaded)
		if err != nil {
			failed[loaded.Spec.ID] = true
			continue
		}
		results[loaded.Spec.ID] = result
	}
	report, err := Score(corpus, results)
	if err != nil {
		return ScoreReport{}, err
	}
	for i := range report.Failures {
		if failed[report.Failures[i].FixtureID] {
			oldCode := report.Failures[i].Code
			report.Failures[i].Code = CodeResultInvalid
			report.Failures[i].Mismatch = "evaluation.failed"
			report.Failures[i].DispositionTrace = nil
			report.FailureGroups[string(oldCode)]--
			report.FailureGroups[string(CodeResultInvalid)]++
		}
	}
	return report, nil
}

// MarshalStable emits the machine-readable matrix result. encoding/json sorts
// map keys, while fixture/failure order remains manifest order.
func (report ScoreReport) MarshalStable() ([]byte, error) {
	return json.Marshal(report)
}

func newScoreReport(manifest Manifest) ScoreReport {
	return ScoreReport{
		SchemaVersion:     manifest.SchemaVersion,
		CorpusGeneration:  manifest.Generation,
		CorpusDigest:      manifest.CorpusDigest,
		TargetBasisPoints: manifest.TargetBasisPoints,
		ByProfile:         make(map[string]Breakdown),
		BySourceSurface:   make(map[string]Breakdown),
		ByTargetSurface:   make(map[string]Breakdown),
		ByProvider:        make(map[string]Breakdown),
		ByFeature:         make(map[string]Breakdown),
		FailureGroups:     make(map[string]int),
	}
}

func compareResult(loaded LoadedFixture, result ScenarioResult, present bool, options ScoreOptions) (bool, Failure) {
	failure := Failure{FixtureID: boundedLabel(loaded.Spec.ID, MaxPathBytes), Tier: loaded.Spec.Tier}
	if !present {
		failure.Code = CodeResultMissing
		failure.Mismatch = "result.missing"
		return false, failure
	}
	if mismatch := resultVersionMismatch(loaded.Spec, result, options); mismatch != "" {
		failure.Code = CodeGenerationMismatch
		failure.Mismatch = mismatch
		return false, failure
	}
	if err := ValidateSemantic(result.Semantic); err != nil {
		failure.Code = CodeResultInvalid
		failure.Mismatch = "semantic.invalid"
		return false, failure
	}
	failure.DispositionTrace = dispositionTrace(result.Dispositions)
	if mismatch := FirstSemanticMismatch(loaded.Fixture.ExpectedSemantic, result.Semantic); mismatch != "" {
		failure.Code = CodeSemanticMismatch
		failure.Mismatch = boundedLabel(mismatch, MaxPathBytes)
		return false, failure
	}
	if mismatch := firstDispositionMismatch(loaded.Spec.Expected.Dispositions, result.Dispositions); mismatch != "" {
		failure.Code = CodeDispositionMismatch
		failure.Mismatch = boundedLabel(mismatch, MaxPathBytes)
		return false, failure
	}
	if mismatch := firstTerminalMismatch(loaded.Spec.Expected.Terminal, result.Terminal); mismatch != "" {
		failure.Code = CodeTerminalMismatch
		failure.Mismatch = boundedLabel(mismatch, MaxPathBytes)
		return false, failure
	}
	return true, Failure{}
}

func resultVersionMismatch(spec FixtureSpec, result ScenarioResult, options ScoreOptions) string {
	if result.ContentGeneration != 0 && result.ContentGeneration != spec.ContentGeneration {
		return "result.content_generation"
	}
	if options.ResultSchemaVersion > 0 {
		if result.SchemaVersion == 0 && options.RequireResultVersion {
			return "result.schema_version.missing"
		}
		if result.SchemaVersion != 0 && result.SchemaVersion != options.ResultSchemaVersion {
			return "result.schema_version"
		}
	}
	if options.ResultGeneration > 0 {
		if result.CorpusGeneration == 0 && options.RequireResultVersion {
			return "result.corpus_generation.missing"
		}
		if result.CorpusGeneration != 0 && result.CorpusGeneration != options.ResultGeneration {
			return "result.corpus_generation"
		}
	}
	return ""
}

func dispositionTrace(values []DispositionExpectation) []DispositionTrace {
	limit := len(values)
	if limit > MaxDispositionTrace {
		limit = MaxDispositionTrace
	}
	trace := make([]DispositionTrace, 0, limit)
	for i := range limit {
		value := values[i]
		trace = append(trace, DispositionTrace{
			SourcePath: boundedLabel(value.SourcePath, MaxPathBytes),
			TargetPath: boundedLabel(value.TargetPath, MaxPathBytes),
			Action:     safeDispositionAction(value.Action),
			RuleID:     boundedLabel(value.RuleID, MaxTokenBytes),
		})
	}
	return trace
}

func safeDispositionAction(action DispositionAction) DispositionAction {
	switch action {
	case DispositionPreserve, DispositionTranslate, DispositionClamp,
		DispositionStripNonSemantic, DispositionReject, DispositionPassthroughNative:
		return action
	default:
		return DispositionReject
	}
}

func firstDispositionMismatch(expected, actual []DispositionExpectation) string {
	if len(expected) != len(actual) {
		return fmt.Sprintf("dispositions.length:%d/%d", len(expected), len(actual))
	}
	for i := range expected {
		left, right := expected[i], actual[i]
		prefix := "dispositions[" + strconv.Itoa(i) + "]"
		if left.SourcePath != right.SourcePath {
			return prefix + ".source_path"
		}
		if left.TargetPath != right.TargetPath {
			return prefix + ".target_path"
		}
		if left.Action != right.Action {
			return prefix + ".action"
		}
		if left.RuleID != right.RuleID {
			return prefix + ".rule_id"
		}
	}
	return ""
}

func recordScenario(report *ScoreReport, spec FixtureSpec, passed bool) {
	addBreakdown(&report.Total, spec.Weight, passed)
	if spec.Tier == 0 {
		addBreakdown(&report.Tier0, spec.Weight, passed)
	} else {
		addBreakdown(&report.Tier1, spec.Weight, passed)
	}
	addMapBreakdown(report.ByProfile, string(spec.Profile), spec.Weight, passed)
	addMapBreakdown(report.BySourceSurface, string(spec.SourceSurface), spec.Weight, passed)
	addMapBreakdown(report.ByTargetSurface, string(spec.Target.Surface), spec.Weight, passed)
	addMapBreakdown(report.ByProvider, spec.Target.Provider, spec.Weight, passed)
	for _, feature := range spec.Features {
		addMapBreakdown(report.ByFeature, string(feature), spec.Weight, passed)
	}
}

func addMapBreakdown(target map[string]Breakdown, key string, weight int, passed bool) {
	value := target[key]
	addBreakdown(&value, weight, passed)
	target[key] = value
}

func addBreakdown(value *Breakdown, weight int, passed bool) {
	value.Scenarios++
	value.TotalWeight += weight
	if passed {
		value.Passed++
		value.PassedWeight += weight
	}
}

func finalizeBreakdowns(report *ScoreReport) {
	finalize := func(value *Breakdown) {
		if value.TotalWeight > 0 {
			value.ScoreBasisPoints = value.PassedWeight * 10000 / value.TotalWeight
		}
	}
	finalize(&report.Total)
	finalize(&report.Tier0)
	finalize(&report.Tier1)
	for key, value := range report.ByProfile {
		finalize(&value)
		report.ByProfile[key] = value
	}
	for key, value := range report.BySourceSurface {
		finalize(&value)
		report.BySourceSurface[key] = value
	}
	for key, value := range report.ByTargetSurface {
		finalize(&value)
		report.ByTargetSurface[key] = value
	}
	for key, value := range report.ByProvider {
		finalize(&value)
		report.ByProvider[key] = value
	}
	for key, value := range report.ByFeature {
		finalize(&value)
		report.ByFeature[key] = value
	}
}
