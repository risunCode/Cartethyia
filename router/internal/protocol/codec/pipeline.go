package codec

import (
	"context"
	"fmt"
	"reflect"
	"strings"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// LossPolicy controls whether stages that may remove or rewrite semantic
// content are allowed to run.
type LossPolicy int

const (
	LosslessOnly LossPolicy = iota
	AllowLossy
)

func (p LossPolicy) String() string {
	switch p {
	case LosslessOnly:
		return "lossless_only"
	case AllowLossy:
		return "allow_lossy"
	default:
		return "unknown"
	}
}

func (p LossPolicy) valid() bool { return p == LosslessOnly || p == AllowLossy }

// StageMetadata is the declaration required for a stage to participate in the
// provider-neutral ordering contract.
type StageMetadata struct {
	Owner             string
	ID                string
	Lossless          bool
	SemanticContract  string
	ActivationPolicy  string
	CachePrefixEffect string
	Order             int
	MarkerPlacement   bool
}

// DescribedStage optionally declares ordering and policy metadata. Existing
// Stage implementations remain source-compatible.
type DescribedStage interface {
	Stage
	Metadata() StageMetadata
}

// LossyStage optionally marks custom stages that can remove or rewrite
// user-visible semantics.
type LossyStage interface {
	Stage
	Lossy() bool
}

// MarkerStage optionally marks stages that render provider cache markers.
type MarkerStage interface {
	Stage
	Marker() bool
}

type Stage interface {
	Name() string
	Apply(context.Context, *NormalizedRequest, LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error)
}

const (
	orderProtocolValidation = 10
	orderLosslessNormalize  = 20
	orderSchemaTools        = 30
	orderLossy              = 40
	orderMedia              = 50
	orderStablePrefix       = 60
	orderCacheMarkers       = 70
)

type Pipeline struct{ stages []Stage }

type PipelineResult struct {
	Request *NormalizedRequest
	Report  contracts.TransformReport
}

// defaultPipeline is built once because its stages are value types with no
// mutable state and Pipeline exposes no operation that mutates stages after
// construction. Apply only reads the validated stage slice, so sharing this
// instance avoids repeating constructor validation on every request.
var (
	defaultPipeline, defaultPipelineErr = buildDefaultPipeline()
)

// NewPipeline validates and copies an ordered stage list. Marker stages must
// be the final stage; canonical named stages may not be reordered.
func NewPipeline(stages ...Stage) (*Pipeline, error) {
	var previousOrder int
	markerIndex := -1
	for i, stage := range stages {
		if isNilStage(stage) {
			return nil, pipelineError(CodeInvalidStage, "", fmt.Sprintf("stages[%d]", i), "stage is required", nil)
		}
		if strings.TrimSpace(stage.Name()) == "" {
			return nil, pipelineError(CodeInvalidStage, "", fmt.Sprintf("stages[%d]", i), "stage name is required", nil)
		}
		meta, described := stageMetadata(stage)
		if described {
			if meta.Order > 0 {
				if previousOrder > meta.Order {
					return nil, pipelineError(CodePipelineOrder, "", stage.Name(), "stage order violates canonical transform order", nil)
				}
				previousOrder = meta.Order
			}
			if meta.MarkerPlacement {
				if markerIndex >= 0 {
					return nil, pipelineError(CodeMarkerLast, "", stage.Name(), "multiple cache marker stages are not allowed", nil)
				}
				markerIndex = i
			}
		}
		if markerIndex >= 0 && i > markerIndex {
			return nil, pipelineError(CodeMarkerLast, "", stage.Name(), "cache markers must be rendered last", nil)
		}
	}
	if markerIndex >= 0 && markerIndex != len(stages)-1 {
		return nil, pipelineError(CodeMarkerLast, "", stages[markerIndex].Name(), "cache markers must be rendered last", nil)
	}
	return &Pipeline{stages: append([]Stage(nil), stages...)}, nil
}

func isNilStage(stage Stage) bool {
	if stage == nil {
		return true
	}
	v := reflect.ValueOf(stage)
	switch v.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Ptr, reflect.Slice:
		return v.IsNil()
	default:
		return false
	}
}

func stageMetadata(stage Stage) (StageMetadata, bool) {
	if described, ok := stage.(DescribedStage); ok {
		meta := described.Metadata()
		if meta.ID == "" {
			meta.ID = stage.Name()
		}
		return meta, true
	}
	if marker, ok := stage.(MarkerStage); ok && marker.Marker() {
		return StageMetadata{ID: stage.Name(), Lossless: true, Order: orderCacheMarkers, MarkerPlacement: true}, true
	}
	name := strings.ToLower(strings.ReplaceAll(stage.Name(), "_", "-"))
	switch {
	case strings.Contains(name, "marker"), strings.Contains(name, "breakpoint"):
		return StageMetadata{ID: stage.Name(), Lossless: true, Order: orderCacheMarkers, MarkerPlacement: true}, true
	case strings.Contains(name, "protocol") && strings.Contains(name, "valid"):
		return StageMetadata{ID: stage.Name(), Lossless: true, Order: orderProtocolValidation}, true
	case strings.Contains(name, "schema") || strings.Contains(name, "tool"):
		return StageMetadata{ID: stage.Name(), Lossless: true, Order: orderSchemaTools}, true
	case strings.Contains(name, "lossy"), strings.Contains(name, "compress"), strings.Contains(name, "truncate"):
		return StageMetadata{ID: stage.Name(), Lossless: false, Order: orderLossy}, true
	case strings.Contains(name, "media"):
		return StageMetadata{ID: stage.Name(), Lossless: true, Order: orderMedia}, true
	case strings.Contains(name, "prefix"), strings.Contains(name, "cache-plan"):
		return StageMetadata{ID: stage.Name(), Lossless: true, Order: orderStablePrefix}, true
	case strings.Contains(name, "normal"):
		return StageMetadata{ID: stage.Name(), Lossless: true, Order: orderLosslessNormalize}, true
	default:
		return StageMetadata{}, false
	}
}

// Apply executes stages in declaration order and returns a bounded,
// secret-free report. Lossy stages are bypassed under LosslessOnly.
func (p *Pipeline) Apply(ctx context.Context, req *NormalizedRequest, policy LossPolicy) (*PipelineResult, error) {
	if p == nil || req == nil {
		return nil, pipelineError(CodeInvalidRequest, surfaceOf(req), "request", "request is required", nil)
	}
	if ctx == nil {
		return nil, pipelineError(CodeInvalidRequest, surfaceOf(req), "context", "context is required", nil)
	}
	if !policy.valid() {
		return nil, pipelineError(CodeLossyPolicy, surfaceOf(req), "policy", "unsupported loss policy", nil)
	}
	if err := req.Validate(); err != nil {
		return nil, pipelineError(CodeInvalidRequest, surfaceOf(req), "request", "request validation failed", err)
	}
	current := req
	report := contracts.TransformReport{}
	for _, stage := range p.stages {
		if err := ctx.Err(); err != nil {
			return nil, pipelineError(CodeContextCanceled, surfaceOf(current), "context", "transform canceled", err)
		}
		meta, described := stageMetadata(stage)
		lossy := described && !meta.Lossless
		if optional, ok := stage.(LossyStage); ok {
			lossy = optional.Lossy()
		}
		if lossy && policy == LosslessOnly {
			report.Diagnostics = append(report.Diagnostics, contracts.TransformDiagnostic{
				Stage:        stage.Name(),
				Action:       "bypass",
				Reason:       "policy=" + policy.String() + "; lossy transform disabled",
				SizeEstimate: requestSizeEstimate(current),
			})
			continue
		}
		next, diag, err := stage.Apply(ctx, current, policy)
		if err != nil {
			return nil, wrapPipelineError(surfaceOf(current), stage.Name(), err)
		}
		if next == nil {
			return nil, pipelineError(CodeStageFailure, surfaceOf(current), stage.Name(), "stage returned nil request", nil)
		}
		if diag.Stage == "" {
			diag.Stage = stage.Name()
		}
		if diag.Action == "" {
			diag.Action = "preserve"
		}
		if diag.SizeEstimate == 0 {
			diag.SizeEstimate = requestSizeEstimate(next)
		}
		if err := diag.Validate(); err != nil {
			return nil, pipelineError(CodeInvalidDiagnostic, surfaceOf(current), stage.Name(), "stage returned invalid diagnostic", err)
		}
		if err := next.Validate(); err != nil {
			return nil, pipelineError(CodeInvalidRequest, surfaceOf(next), stage.Name(), "stage returned invalid request", err)
		}
		report.Diagnostics = append(report.Diagnostics, diag)
		if err := report.Validate(); err != nil {
			return nil, pipelineError(CodeInvalidDiagnostic, surfaceOf(next), stage.Name(), "transform report exceeded bounds", err)
		}
		current = next
	}
	if err := ctx.Err(); err != nil {
		return nil, pipelineError(CodeContextCanceled, surfaceOf(current), "context", "transform canceled", err)
	}
	if err := current.Validate(); err != nil {
		return nil, pipelineError(CodeInvalidRequest, surfaceOf(current), "request", "final transform validation failed", err)
	}
	if err := report.Validate(); err != nil {
		return nil, pipelineError(CodeInvalidDiagnostic, surfaceOf(current), "report", "transform report exceeded bounds", err)
	}
	return &PipelineResult{Request: current, Report: report}, nil
}

func surfaceOf(req *NormalizedRequest) string {
	if req == nil {
		return ""
	}
	return string(req.Source)
}

type IdentityStage struct{ ID string }

func (s IdentityStage) Name() string {
	if s.ID == "" {
		return "identity"
	}
	return s.ID
}

func (s IdentityStage) Metadata() StageMetadata {
	return StageMetadata{
		Owner:             "transforms",
		ID:                s.Name(),
		Lossless:          true,
		SemanticContract:  "request identity",
		ActivationPolicy:  "always",
		CachePrefixEffect: "preserve",
	}
}

func (s IdentityStage) Apply(_ context.Context, req *NormalizedRequest, _ LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error) {
	if req == nil {
		return nil, contracts.TransformDiagnostic{}, pipelineError(CodeInvalidRequest, "", "request", "request is required", nil)
	}
	return req, contracts.TransformDiagnostic{Stage: s.Name(), Action: "preserve", Reason: "lossless identity"}, nil
}

func buildDefaultPipeline() (*Pipeline, error) {
	return NewPipeline(
		ProtocolValidationStage{},
		LosslessNormalizationStage{},
		SchemaToolNormalizationStage{},
		ToolCallInvariantStage{},
		LossyTransformStage{},
		MediaNormalizationStage{},
		StablePrefixStage{},
		CacheMarkerStage{},
	)
}

// NewDefaultPipeline returns the canonical provider-neutral request pipeline.
// The returned pipeline is immutable and safe for concurrent Apply calls.
func NewDefaultPipeline() (*Pipeline, error) { return defaultPipeline, defaultPipelineErr }

// NewProviderNeutralPipeline is an explicit alias for NewDefaultPipeline.
func NewProviderNeutralPipeline() (*Pipeline, error) { return NewDefaultPipeline() }

// DefaultPipeline is a constructor-style alias for callers that prefer the
// shorter name.
func DefaultPipeline() (*Pipeline, error) { return NewDefaultPipeline() }
