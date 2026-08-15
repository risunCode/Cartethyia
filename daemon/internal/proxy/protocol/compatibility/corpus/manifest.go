// Package corpus loads and validates the versioned, synthetic compatibility corpus.
// It is test and offline-tool support; it does not plan or translate live requests.
package corpus

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/cartethyia/daemon/internal/proxy/protocol/compatibility"
)

const (
	CurrentSchemaVersion  = 1
	MaxManifestBytes      = 1 << 20
	MaxFixtureBytes       = 256 << 10
	MaxScenarios          = 2048
	MaxFeaturesPerFixture = 64
	MaxDispositions       = 128
	MaxTokenBytes         = 128
	MaxPathBytes          = 256
	MaxWeight             = 1000
)

type ErrorCode string

const (
	CodeInvalidInput        ErrorCode = "corpus.invalid_input"
	CodeManifestInvalid     ErrorCode = "corpus.manifest_invalid"
	CodeFixtureInvalid      ErrorCode = "corpus.fixture_invalid"
	CodeGenerationRequired  ErrorCode = "corpus.generation_required"
	CodeGenerationMismatch  ErrorCode = "corpus.generation_mismatch"
	CodeSemanticMismatch    ErrorCode = "corpus.semantic_mismatch"
	CodeDispositionMismatch ErrorCode = "corpus.disposition_mismatch"
	CodeTerminalMismatch    ErrorCode = "corpus.terminal_mismatch"
	CodeResultMissing       ErrorCode = "corpus.result_missing"
	CodeResultInvalid       ErrorCode = "corpus.result_invalid"
)

type Stage string

const (
	StageManifest   Stage = "manifest"
	StageFixture    Stage = "fixture"
	StageGeneration Stage = "generation"
	StageScore      Stage = "score"
)

// Error is a secret-safe corpus failure. Error intentionally omits the wrapped
// decoder or filesystem message; callers may inspect Cause with errors.Is/As.
type Error struct {
	Code  ErrorCode
	Stage Stage
	Field string
	Cause error
}

func (e *Error) Error() string {
	if e == nil {
		return "<nil corpus error>"
	}
	out := string(e.Code)
	if e.Stage != "" {
		out += ": stage=" + string(e.Stage)
	}
	if e.Field != "" {
		out += ": field=" + boundedLabel(e.Field, MaxPathBytes)
	}
	return out
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func (e *Error) CodeString() string {
	if e == nil {
		return ""
	}
	return string(e.Code)
}

func CodeOf(err error) ErrorCode {
	var typed *Error
	if errors.As(err, &typed) && typed != nil {
		return typed.Code
	}
	return ""
}

type OperationKind string

type CompactionVersion string

const (
	OperationGenerate         OperationKind = "generate"
	OperationRemoteCompaction OperationKind = "remote-compaction"

	CompactionNone CompactionVersion = ""
	CompactionV1   CompactionVersion = "v1"
	CompactionV2   CompactionVersion = "v2"
)

type Surface string

const (
	SurfaceOpenAIChat      Surface = "openai-chat"
	SurfaceOpenAIResponses Surface = "openai-responses"
	SurfaceAnthropic       Surface = "anthropic-messages"
	SurfaceGemini          Surface = "gemini-native"
	SurfaceImages          Surface = "images"
)

type Feature string

const (
	FeatureText               Feature = "text"
	FeatureMultipleSystem     Feature = "multiple-system"
	FeatureTools              Feature = "tools"
	FeatureFunctionTool       Feature = "function-tool"
	FeatureCustomTool         Feature = "custom-tool"
	FeatureComputerTool       Feature = "computer-tool"
	FeatureHostedTool         Feature = "hosted-tool"
	FeatureToolCall           Feature = "tool-call"
	FeatureToolResult         Feature = "tool-result"
	FeatureParallelTools      Feature = "parallel-tools"
	FeatureReasoning          Feature = "reasoning"
	FeatureEncryptedReasoning Feature = "encrypted-reasoning"
	FeatureStructuredOutput   Feature = "structured-output"
	FeatureImage              Feature = "image"
	FeatureAudio              Feature = "audio"
	FeatureFile               Feature = "file"
	FeaturePDF                Feature = "pdf"
	FeatureCitation           Feature = "citation"
	FeatureUsage              Feature = "usage"
	FeatureStreaming          Feature = "streaming"
	FeatureRemoteCompactionV1 Feature = "remote-compaction-v1"
	FeatureRemoteCompactionV2 Feature = "remote-compaction-v2"
	FeatureContextManagement  Feature = "context-management"
	FeatureContinuation       Feature = "continuation"
	FeatureUnknownFields      Feature = "unknown-fields"
)

var knownFeatures = map[Feature]struct{}{
	FeatureText: {}, FeatureMultipleSystem: {}, FeatureTools: {}, FeatureFunctionTool: {},
	FeatureCustomTool: {}, FeatureComputerTool: {}, FeatureHostedTool: {}, FeatureToolCall: {},
	FeatureToolResult: {}, FeatureParallelTools: {}, FeatureReasoning: {}, FeatureEncryptedReasoning: {},
	FeatureStructuredOutput: {}, FeatureImage: {}, FeatureAudio: {}, FeatureFile: {}, FeaturePDF: {},
	FeatureCitation: {}, FeatureUsage: {}, FeatureStreaming: {}, FeatureRemoteCompactionV1: {},
	FeatureRemoteCompactionV2: {}, FeatureContextManagement: {}, FeatureContinuation: {}, FeatureUnknownFields: {},
}

type DispositionAction string

const (
	DispositionPreserve          DispositionAction = "preserve"
	DispositionTranslate         DispositionAction = "translate"
	DispositionClamp             DispositionAction = "clamp"
	DispositionStripNonSemantic  DispositionAction = "strip-nonsemantic"
	DispositionReject            DispositionAction = "reject"
	DispositionPassthroughNative DispositionAction = "passthrough-native"
)

type Manifest struct {
	SchemaVersion     int           `json:"schema_version"`
	Generation        int           `json:"generation"`
	CorpusDigest      string        `json:"corpus_digest"`
	TargetBasisPoints int           `json:"target_basis_points"`
	Fixtures          []FixtureSpec `json:"fixtures"`
}

type FixtureSpec struct {
	ID                string                        `json:"id"`
	ContentGeneration int                           `json:"content_generation"`
	File              string                        `json:"file"`
	ContentDigest     string                        `json:"content_digest"`
	Profile           compatibility.ClientProfileID `json:"profile"`
	Operation         Operation                     `json:"operation"`
	SourceSurface     Surface                       `json:"source_surface"`
	Target            Target                        `json:"target"`
	Stream            bool                          `json:"stream"`
	Features          []Feature                     `json:"features"`
	Weight            int                           `json:"weight"`
	Tier              int                           `json:"tier"`
	Expected          Expected                      `json:"expected"`
}

type Operation struct {
	Kind              OperationKind     `json:"kind"`
	CompactionVersion CompactionVersion `json:"compaction_version,omitempty"`
}

type Target struct {
	Provider string              `json:"provider"`
	Surface  Surface             `json:"surface"`
	Model    string              `json:"model"`
	Policy   ProviderModelPolicy `json:"policy"`
}

type ProviderModelPolicy struct {
	ID         string `json:"id"`
	Generation int    `json:"generation"`
}

type Expected struct {
	SemanticDigest string                   `json:"semantic_digest"`
	Dispositions   []DispositionExpectation `json:"dispositions"`
	Terminal       TerminalExpectation      `json:"terminal"`
}

type DispositionExpectation struct {
	SourcePath string            `json:"source_path"`
	TargetPath string            `json:"target_path,omitempty"`
	Action     DispositionAction `json:"action"`
	RuleID     string            `json:"rule_id,omitempty"`
}

type TerminalExpectation struct {
	Status     string   `json:"status"`
	Event      string   `json:"event"`
	StopReason string   `json:"stop_reason,omitempty"`
	ErrorCode  string   `json:"error_code,omitempty"`
	Sequence   []string `json:"sequence,omitempty"`
}

type Fixture struct {
	ID                string          `json:"id"`
	ContentGeneration int             `json:"content_generation"`
	Request           json.RawMessage `json:"request"`
	ExpectedSemantic  Semantic        `json:"expected_semantic"`
}

type LoadedFixture struct {
	Spec    FixtureSpec
	Fixture Fixture
}

type Corpus struct {
	Manifest Manifest
	Fixtures []LoadedFixture
}

func Load(root string) (*Corpus, error) {
	if strings.TrimSpace(root) == "" {
		return nil, corpusError(CodeInvalidInput, StageManifest, "root", nil)
	}
	manifestBytes, err := readBounded(filepath.Join(root, "manifest.json"), MaxManifestBytes)
	if err != nil {
		return nil, corpusError(CodeManifestInvalid, StageManifest, "manifest.json", err)
	}
	manifest, err := DecodeManifest(bytes.NewReader(manifestBytes))
	if err != nil {
		return nil, err
	}
	loaded := make([]LoadedFixture, 0, len(manifest.Fixtures))
	for i := range manifest.Fixtures {
		spec := manifest.Fixtures[i]
		data, readErr := readFixture(root, spec.File)
		if readErr != nil {
			return nil, corpusError(CodeFixtureInvalid, StageFixture, spec.ID, readErr)
		}
		if digest, digestErr := DigestJSON(data); digestErr != nil || digest != spec.ContentDigest {
			return nil, corpusError(CodeFixtureInvalid, StageFixture, spec.ID+".content_digest", digestErr)
		}
		fixture, decodeErr := DecodeFixture(bytes.NewReader(data))
		if decodeErr != nil {
			return nil, decodeErr
		}
		if fixture.ID != spec.ID || fixture.ContentGeneration != spec.ContentGeneration {
			return nil, corpusError(CodeGenerationMismatch, StageFixture, spec.ID, nil)
		}
		semanticDigest, digestErr := SemanticDigest(fixture.ExpectedSemantic)
		if digestErr != nil || semanticDigest != spec.Expected.SemanticDigest {
			return nil, corpusError(CodeFixtureInvalid, StageFixture, spec.ID+".semantic_digest", digestErr)
		}
		if mismatch := firstTerminalMismatch(spec.Expected.Terminal, fixture.ExpectedSemantic.Terminal); mismatch != "" {
			return nil, corpusError(CodeFixtureInvalid, StageFixture, spec.ID+"."+mismatch, nil)
		}
		loaded = append(loaded, LoadedFixture{Spec: spec, Fixture: fixture})
	}
	return &Corpus{Manifest: manifest, Fixtures: loaded}, nil
}

func DecodeManifest(r io.Reader) (Manifest, error) {
	if r == nil {
		return Manifest{}, corpusError(CodeInvalidInput, StageManifest, "reader", nil)
	}
	var manifest Manifest
	if err := decodeStrict(r, &manifest); err != nil {
		return Manifest{}, corpusError(CodeManifestInvalid, StageManifest, "json", err)
	}
	if err := ValidateManifest(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func DecodeFixture(r io.Reader) (Fixture, error) {
	if r == nil {
		return Fixture{}, corpusError(CodeInvalidInput, StageFixture, "reader", nil)
	}
	var fixture Fixture
	if err := decodeStrict(r, &fixture); err != nil {
		return Fixture{}, corpusError(CodeFixtureInvalid, StageFixture, "json", err)
	}
	if !validID(fixture.ID) || fixture.ContentGeneration < 1 || len(fixture.Request) == 0 || len(fixture.Request) > MaxFixtureBytes {
		return Fixture{}, corpusError(CodeFixtureInvalid, StageFixture, "identity", nil)
	}
	if err := ValidateSyntheticJSON(fixture.Request); err != nil {
		return Fixture{}, err
	}
	if err := ValidateSemantic(fixture.ExpectedSemantic); err != nil {
		return Fixture{}, err
	}
	return fixture, nil
}

func ValidateManifest(manifest Manifest) error {
	if manifest.SchemaVersion != CurrentSchemaVersion {
		return corpusError(CodeManifestInvalid, StageManifest, "schema_version", nil)
	}
	if manifest.Generation < 1 {
		return corpusError(CodeManifestInvalid, StageManifest, "generation", nil)
	}
	if manifest.TargetBasisPoints < 1 || manifest.TargetBasisPoints > 10000 {
		return corpusError(CodeManifestInvalid, StageManifest, "target_basis_points", nil)
	}
	if len(manifest.Fixtures) == 0 || len(manifest.Fixtures) > MaxScenarios {
		return corpusError(CodeManifestInvalid, StageManifest, "fixtures", nil)
	}
	seenIDs := make(map[string]struct{}, len(manifest.Fixtures))
	seenFiles := make(map[string]struct{}, len(manifest.Fixtures))
	tierOneWeight := 0
	for i := range manifest.Fixtures {
		spec := manifest.Fixtures[i]
		field := fmt.Sprintf("fixtures[%d]", i)
		if !validID(spec.ID) {
			return corpusError(CodeManifestInvalid, StageManifest, field+".id", nil)
		}
		if _, duplicate := seenIDs[spec.ID]; duplicate {
			return corpusError(CodeManifestInvalid, StageManifest, field+".id", nil)
		}
		seenIDs[spec.ID] = struct{}{}
		cleanFile, ok := cleanRelativeJSONPath(spec.File)
		if !ok || cleanFile != filepath.Clean(spec.File) {
			return corpusError(CodeManifestInvalid, StageManifest, field+".file", nil)
		}
		if _, duplicate := seenFiles[cleanFile]; duplicate {
			return corpusError(CodeManifestInvalid, StageManifest, field+".file", nil)
		}
		seenFiles[cleanFile] = struct{}{}
		if spec.ContentGeneration < 1 {
			return corpusError(CodeManifestInvalid, StageManifest, field+".content_generation", nil)
		}
		if !validSHA256(spec.ContentDigest) || !validSHA256(spec.Expected.SemanticDigest) {
			return corpusError(CodeManifestInvalid, StageManifest, field+".digest", nil)
		}
		if !knownProfile(spec.Profile) || !knownSurface(spec.SourceSurface) || !knownSurface(spec.Target.Surface) {
			return corpusError(CodeManifestInvalid, StageManifest, field+".surface_or_profile", nil)
		}
		if !validToken(spec.Target.Provider) || !validToken(spec.Target.Model) || !validToken(spec.Target.Policy.ID) || spec.Target.Policy.Generation < 1 {
			return corpusError(CodeManifestInvalid, StageManifest, field+".target", nil)
		}
		if err := validateOperation(spec.Operation); err != nil {
			return corpusError(CodeManifestInvalid, StageManifest, field+".operation", err)
		}
		if len(spec.Features) == 0 || len(spec.Features) > MaxFeaturesPerFixture {
			return corpusError(CodeManifestInvalid, StageManifest, field+".features", nil)
		}
		featureSet := make(map[Feature]struct{}, len(spec.Features))
		for _, feature := range spec.Features {
			if _, known := knownFeatures[feature]; !known {
				return corpusError(CodeManifestInvalid, StageManifest, field+".features", nil)
			}
			if _, duplicate := featureSet[feature]; duplicate {
				return corpusError(CodeManifestInvalid, StageManifest, field+".features", nil)
			}
			featureSet[feature] = struct{}{}
		}
		if spec.Weight < 1 || spec.Weight > MaxWeight || (spec.Tier != 0 && spec.Tier != 1) {
			return corpusError(CodeManifestInvalid, StageManifest, field+".weight_or_tier", nil)
		}
		if spec.Tier == 1 {
			tierOneWeight += spec.Weight
		}
		if len(spec.Expected.Dispositions) == 0 || len(spec.Expected.Dispositions) > MaxDispositions {
			return corpusError(CodeManifestInvalid, StageManifest, field+".expected.dispositions", nil)
		}
		for j := range spec.Expected.Dispositions {
			if err := validateDisposition(spec.Expected.Dispositions[j]); err != nil {
				return corpusError(CodeManifestInvalid, StageManifest, fmt.Sprintf("%s.expected.dispositions[%d]", field, j), err)
			}
		}
		if err := validateTerminal(spec.Expected.Terminal); err != nil {
			return corpusError(CodeManifestInvalid, StageManifest, field+".expected.terminal", err)
		}
	}
	if tierOneWeight == 0 {
		return corpusError(CodeManifestInvalid, StageManifest, "fixtures.tier_one", nil)
	}
	calculated, err := ManifestDigest(manifest)
	if err != nil || calculated != manifest.CorpusDigest {
		return corpusError(CodeManifestInvalid, StageManifest, "corpus_digest", err)
	}
	return nil
}

// ValidateGeneration rejects score-affecting changes that retain the same
// manifest generation. It also prevents generation rollback.
func ValidateGeneration(previous, current Manifest) error {
	if previous.Generation < 1 || current.Generation < 1 {
		return corpusError(CodeInvalidInput, StageGeneration, "generation", nil)
	}
	if current.Generation < previous.Generation {
		return corpusError(CodeGenerationMismatch, StageGeneration, "generation", nil)
	}
	before, err := ManifestDigest(previous)
	if err != nil {
		return corpusError(CodeManifestInvalid, StageGeneration, "previous", err)
	}
	after, err := ManifestDigest(current)
	if err != nil {
		return corpusError(CodeManifestInvalid, StageGeneration, "current", err)
	}
	if before != after && current.Generation == previous.Generation {
		return corpusError(CodeGenerationRequired, StageGeneration, "generation", nil)
	}
	return nil
}

// ManifestDigest hashes all score-affecting manifest fields except the digest
// itself. The returned lowercase SHA-256 value is safe to publish.
func ManifestDigest(manifest Manifest) (string, error) {
	manifest.CorpusDigest = ""
	data, err := json.Marshal(manifest)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func KnownFeatures() []Feature {
	out := make([]Feature, 0, len(knownFeatures))
	for feature := range knownFeatures {
		out = append(out, feature)
	}
	slicesSortFeatures(out)
	return out
}

func corpusError(code ErrorCode, stage Stage, field string, cause error) error {
	return &Error{Code: code, Stage: stage, Field: boundedLabel(field, MaxPathBytes), Cause: cause}
}

func readBounded(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("corpus file exceeds byte limit")
	}
	return data, nil
}

func readFixture(root, relative string) ([]byte, error) {
	clean, ok := cleanRelativeJSONPath(relative)
	if !ok {
		return nil, errors.New("invalid fixture path")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	pathAbs, err := filepath.Abs(filepath.Join(rootAbs, clean))
	if err != nil {
		return nil, err
	}
	rel, err := filepath.Rel(rootAbs, pathAbs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil, errors.New("fixture path escapes corpus root")
	}
	return readBounded(pathAbs, MaxFixtureBytes)
}

func decodeStrict(r io.Reader, value any) error {
	decoder := json.NewDecoder(io.LimitReader(r, MaxManifestBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,127}$`)
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$`)
var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func validID(value string) bool     { return idPattern.MatchString(value) }
func validToken(value string) bool  { return tokenPattern.MatchString(value) }
func validSHA256(value string) bool { return sha256Pattern.MatchString(value) }

func cleanRelativeJSONPath(value string) (string, bool) {
	if value == "" || len(value) > MaxPathBytes || filepath.IsAbs(value) || filepath.Ext(value) != ".json" {
		return "", false
	}
	clean := filepath.Clean(filepath.FromSlash(value))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", false
	}
	return clean, true
}

func knownProfile(profile compatibility.ClientProfileID) bool {
	switch profile {
	case compatibility.ProfileUnknownStandard, compatibility.ProfileClaudeCode,
		compatibility.ProfileCodexCLI, compatibility.ProfileGeminiCLI,
		compatibility.ProfileOpenAICompatible:
		return true
	default:
		return false
	}
}

func knownSurface(surface Surface) bool {
	switch surface {
	case SurfaceOpenAIChat, SurfaceOpenAIResponses, SurfaceAnthropic, SurfaceGemini, SurfaceImages:
		return true
	default:
		return false
	}
}

func validateOperation(operation Operation) error {
	switch operation.Kind {
	case OperationGenerate:
		if operation.CompactionVersion != CompactionNone {
			return errors.New("generation cannot carry compaction version")
		}
	case OperationRemoteCompaction:
		if operation.CompactionVersion != CompactionV1 && operation.CompactionVersion != CompactionV2 {
			return errors.New("remote compaction requires a supported version")
		}
	default:
		return errors.New("unknown operation kind")
	}
	return nil
}

func validateDisposition(disposition DispositionExpectation) error {
	if disposition.SourcePath == "" || len(disposition.SourcePath) > MaxPathBytes || len(disposition.TargetPath) > MaxPathBytes {
		return errors.New("invalid disposition path")
	}
	switch disposition.Action {
	case DispositionPreserve, DispositionTranslate, DispositionClamp,
		DispositionStripNonSemantic, DispositionReject, DispositionPassthroughNative:
	default:
		return errors.New("unknown disposition action")
	}
	if disposition.Action != DispositionPreserve && disposition.Action != DispositionTranslate &&
		disposition.Action != DispositionPassthroughNative && !validToken(disposition.RuleID) {
		return errors.New("rule id is required")
	}
	if disposition.RuleID != "" && !validToken(disposition.RuleID) {
		return errors.New("invalid rule id")
	}
	return nil
}

func validateTerminal(terminal TerminalExpectation) error {
	if terminal.Status != "success" && terminal.Status != "incomplete" && terminal.Status != "error" {
		return errors.New("invalid terminal status")
	}
	if !validToken(terminal.Event) || len(terminal.Sequence) > 32 {
		return errors.New("invalid terminal event")
	}
	if terminal.StopReason != "" && !validToken(terminal.StopReason) {
		return errors.New("invalid stop reason")
	}
	if terminal.ErrorCode != "" && !validToken(terminal.ErrorCode) {
		return errors.New("invalid error code")
	}
	if terminal.Status == "error" && terminal.ErrorCode == "" {
		return errors.New("error terminal requires code")
	}
	for _, event := range terminal.Sequence {
		if !validToken(event) {
			return errors.New("invalid terminal sequence")
		}
	}
	return nil
}

func boundedLabel(value string, limit int) string {
	if len(value) > limit {
		value = value[:limit]
	}
	var builder strings.Builder
	builder.Grow(len(value))
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("._[]/-", r) {
			builder.WriteRune(r)
		} else {
			builder.WriteByte('_')
		}
	}
	return builder.String()
}

func slicesSortFeatures(values []Feature) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
