package transforms

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/jsonclone"
)

// ProtocolValidationStage performs the first fail-closed canonical validation.
type ProtocolValidationStage struct{}

func (ProtocolValidationStage) Name() string { return "protocol-validation" }
func (s ProtocolValidationStage) Metadata() StageMetadata {
	return StageMetadata{Owner: "transforms", ID: s.Name(), Lossless: true, SemanticContract: "validated canonical request", ActivationPolicy: "always", CachePrefixEffect: "preserve", Order: orderProtocolValidation}
}
func (s ProtocolValidationStage) Apply(_ context.Context, req *NormalizedRequest, _ LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error) {
	if req == nil {
		return nil, contracts.TransformDiagnostic{}, pipelineError(CodeInvalidRequest, "", "request", "request is required", nil)
	}
	if err := req.Validate(); err != nil {
		return nil, contracts.TransformDiagnostic{}, pipelineError(CodeInvalidRequest, surfaceOf(req), "request", "request validation failed", err)
	}
	return req, contracts.TransformDiagnostic{Stage: s.Name(), Action: "validate", Reason: "canonical request accepted"}, nil
}

// LosslessNormalizationStage clones caller-owned data and compacts valid JSON
// tool arguments without changing their semantic value.
type LosslessNormalizationStage struct{}

func (LosslessNormalizationStage) Name() string { return "lossless-normalization" }
func (s LosslessNormalizationStage) Metadata() StageMetadata {
	return StageMetadata{Owner: "transforms", ID: s.Name(), Lossless: true, SemanticContract: "preserve content and ordering", ActivationPolicy: "always", CachePrefixEffect: "preserve", Order: orderLosslessNormalize}
}
func (s LosslessNormalizationStage) Apply(_ context.Context, req *NormalizedRequest, _ LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error) {
	if req == nil {
		return nil, contracts.TransformDiagnostic{}, pipelineError(CodeInvalidRequest, "", "request", "request is required", nil)
	}
	out := cloneNormalizedRequest(req)
	for mi := range out.Messages {
		for bi := range out.Messages[mi].Content {
			block := &out.Messages[mi].Content[bi]
			if block.Type == BlockToolUse && block.ToolArguments != "" && !toolArgumentsAreFreeform(out, *block) {
				block.ToolArguments = RepairToolCallArguments(block.ToolArguments)
			}
		}
	}
	return out, contracts.TransformDiagnostic{Stage: s.Name(), Action: "preserve", Reason: "lossless ownership and JSON normalization"}, nil
}

// SchemaToolNormalizationStage normalizes tool argument JSON and clones schema
// values. It never drops a tool or changes its declaration.
type SchemaToolNormalizationStage struct{}

func (SchemaToolNormalizationStage) Name() string { return "schema-tool-normalization" }
func (s SchemaToolNormalizationStage) Metadata() StageMetadata {
	return StageMetadata{Owner: "transforms", ID: s.Name(), Lossless: true, SemanticContract: "preserve tool signatures", ActivationPolicy: "always", CachePrefixEffect: "preserve", Order: orderSchemaTools}
}
func (s SchemaToolNormalizationStage) Apply(_ context.Context, req *NormalizedRequest, _ LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error) {
	if req == nil {
		return nil, contracts.TransformDiagnostic{}, pipelineError(CodeInvalidRequest, "", "request", "request is required", nil)
	}
	out := cloneNormalizedRequest(req)
	for i := range out.Tools {
		if out.Tools[i].InputSchema == nil {
			continue
		}
		out.Tools[i].InputSchema = jsonclone.CloneMap(out.Tools[i].InputSchema)
	}
	for mi := range out.Messages {
		for bi := range out.Messages[mi].Content {
			block := &out.Messages[mi].Content[bi]
			if block.Type == BlockToolUse && block.ToolArguments != "" && !toolArgumentsAreFreeform(out, *block) {
				if !json.Valid([]byte(block.ToolArguments)) {
					return nil, contracts.TransformDiagnostic{}, pipelineError(CodeUnsupportedFeature, surfaceOf(req), fmt.Sprintf("messages[%d].content[%d].tool_arguments", mi, bi), "tool arguments are not valid JSON", nil)
				}
				block.ToolArguments = RepairToolCallArguments(block.ToolArguments)
			}
		}
	}
	return out, contracts.TransformDiagnostic{Stage: s.Name(), Action: "preserve", Reason: "tool schemas and arguments normalized losslessly"}, nil
}

// LossyTransform is an optional callback used by LossyTransformStage. The
// callback must return a non-nil request and must not fabricate provider data.
type LossyTransform func(context.Context, *NormalizedRequest) (*NormalizedRequest, error)

// LossyTransformStage is policy-gated by Pipeline.Apply. A nil callback is a
// deliberate no-op, useful when composing a pipeline with optional compression.
type LossyTransformStage struct {
	ID        string
	Transform LossyTransform
}

func (s LossyTransformStage) Name() string {
	if s.ID == "" {
		return "lossy-transforms"
	}
	return s.ID
}
func (s LossyTransformStage) Metadata() StageMetadata {
	return StageMetadata{Owner: "transforms", ID: s.Name(), Lossless: false, SemanticContract: "loss allowed only by explicit policy", ActivationPolicy: "allow_lossy", CachePrefixEffect: "invalidate", Order: orderLossy}
}
func (s LossyTransformStage) Lossy() bool { return true }
func (s LossyTransformStage) Apply(ctx context.Context, req *NormalizedRequest, policy LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error) {
	if req == nil {
		return nil, contracts.TransformDiagnostic{}, pipelineError(CodeInvalidRequest, "", "request", "request is required", nil)
	}
	if policy != AllowLossy {
		return req, contracts.TransformDiagnostic{Stage: s.Name(), Action: "bypass", Reason: "policy=" + policy.String() + "; lossy transform disabled"}, nil
	}
	if s.Transform == nil {
		return req, contracts.TransformDiagnostic{Stage: s.Name(), Action: "preserve", Reason: "no lossy transform configured"}, nil
	}
	out, err := s.Transform(ctx, req)
	if err != nil {
		return nil, contracts.TransformDiagnostic{}, pipelineError(CodeLossyPolicy, surfaceOf(req), s.Name(), "lossy transform rejected", err)
	}
	if out == nil {
		return nil, contracts.TransformDiagnostic{}, pipelineError(CodeStageFailure, surfaceOf(req), s.Name(), "lossy transform returned nil request", nil)
	}
	return out, contracts.TransformDiagnostic{Stage: s.Name(), Action: "lossy", Reason: "policy=allow_lossy; semantic loss explicitly allowed"}, nil
}

// MediaNormalizationStage handles equivalent media references in the
// side-channel image list while retaining every content-block occurrence.
type MediaNormalizationStage struct{}

func (MediaNormalizationStage) Name() string { return "media-normalization" }
func (s MediaNormalizationStage) Metadata() StageMetadata {
	return StageMetadata{Owner: "transforms", ID: s.Name(), Lossless: true, SemanticContract: "equivalent media references share identity", ActivationPolicy: "always", CachePrefixEffect: "preserve", Order: orderMedia}
}
func (s MediaNormalizationStage) Apply(_ context.Context, req *NormalizedRequest, _ LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error) {
	if req == nil {
		return nil, contracts.TransformDiagnostic{}, pipelineError(CodeInvalidRequest, "", "request", "request is required", nil)
	}
	out := cloneNormalizedRequest(req)
	for mi := range out.Messages {
		for bi := range out.Messages[mi].Content {
			if out.Messages[mi].Content[bi].Image != nil {
				out.Messages[mi].Content[bi].Image.MediaType = strings.ToLower(out.Messages[mi].Content[bi].Image.MediaType)
			}
		}
	}
	seen := make(map[string]struct{}, len(out.Images))
	images := make([]ImageReference, 0, len(out.Images))
	for _, image := range out.Images {
		image.MediaType = strings.ToLower(image.MediaType)
		key := string(image.Kind) + "\x00" + image.MediaType + "\x00" + image.Value
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		images = append(images, image)
	}
	out.Images = images
	return out, contracts.TransformDiagnostic{Stage: s.Name(), Action: "normalize", Reason: "equivalent media references deduplicated"}, nil
}

// StablePrefixStage is intentionally provider-neutral. It records that no
// cache-prefix-affecting mutation occurred; cacheplan computes the actual
// provider intent from the resulting canonical request.
type StablePrefixStage struct{}

func (StablePrefixStage) Name() string { return "stable-prefix" }
func (s StablePrefixStage) Metadata() StageMetadata {
	return StageMetadata{Owner: "transforms", ID: s.Name(), Lossless: true, SemanticContract: "stable cache prefix", ActivationPolicy: "always", CachePrefixEffect: "preserve", Order: orderStablePrefix}
}
func (s StablePrefixStage) Apply(_ context.Context, req *NormalizedRequest, _ LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error) {
	if req == nil {
		return nil, contracts.TransformDiagnostic{}, pipelineError(CodeInvalidRequest, "", "request", "request is required", nil)
	}
	return req, contracts.TransformDiagnostic{Stage: s.Name(), Action: "preserve", Reason: "cache prefix remains stable until provider planning"}, nil
}

// CacheMarkerStage validates existing canonical markers and is intentionally a
// final transform. Provider-specific marker rendering remains in cacheplan and
// the surface encoders; this stage cannot be followed by another transform.
type CacheMarkerStage struct{}

func (CacheMarkerStage) Name() string { return "cache-markers" }
func (s CacheMarkerStage) Metadata() StageMetadata {
	return StageMetadata{Owner: "transforms", ID: s.Name(), Lossless: true, SemanticContract: "validate marker placement", ActivationPolicy: "cache-supported", CachePrefixEffect: "preserve", Order: orderCacheMarkers, MarkerPlacement: true}
}
func (s CacheMarkerStage) Marker() bool { return true }
func (s CacheMarkerStage) Apply(_ context.Context, req *NormalizedRequest, _ LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error) {
	if req == nil {
		return nil, contracts.TransformDiagnostic{}, pipelineError(CodeInvalidRequest, "", "request", "request is required", nil)
	}
	for mi, message := range req.Messages {
		for bi, block := range message.Content {
			if block.CacheControl != "" && block.CacheControl != "ephemeral" {
				return nil, contracts.TransformDiagnostic{}, pipelineError(CodeUnsupportedFeature, surfaceOf(req), fmt.Sprintf("messages[%d].content[%d].cache_control", mi, bi), "unsupported cache marker", nil)
			}
		}
	}
	return req, contracts.TransformDiagnostic{Stage: s.Name(), Action: "validate", Reason: "cache markers validated as final transform"}, nil
}

func cloneNormalizedRequest(in *NormalizedRequest) *NormalizedRequest {
	if in == nil {
		return nil
	}
	out := *in
	out.Native = in.Native.Clone()
	out.Messages = append([]NormalizedMessage(nil), in.Messages...)
	for i := range out.Messages {
		out.Messages[i].Content = append([]ContentBlock(nil), in.Messages[i].Content...)
		for j := range out.Messages[i].Content {
			out.Messages[i].Content[j] = cloneContentBlock(in.Messages[i].Content[j])
			block := &out.Messages[i].Content[j]
			block.Image = cloneImage(block.Image)
			block.ReasoningSummary = jsonclone.CloneMapList(block.ReasoningSummary)
			block.NativePayload = jsonclone.CloneMap(block.NativePayload)
			block.Raw = jsonclone.CloneMap(block.Raw)
		}
		out.Messages[i].ReasoningItemsBefore = jsonclone.CloneMapList(in.Messages[i].ReasoningItemsBefore)
	}
	out.Tools = append([]Tool(nil), in.Tools...)
	for i := range out.Tools {
		out.Tools[i].InputSchema = jsonclone.CloneMap(in.Tools[i].InputSchema)
		out.Tools[i].NativeOptions = jsonclone.CloneMap(in.Tools[i].NativeOptions)
		out.Tools[i].AllowedCallers = append([]string(nil), in.Tools[i].AllowedCallers...)
		out.Tools[i].InputExamples = jsonclone.CloneMapList(in.Tools[i].InputExamples)
		if in.Tools[i].Format != nil {
			format := *in.Tools[i].Format
			format.Schema = cloneRaw(in.Tools[i].Format.Schema)
			out.Tools[i].Format = &format
		}
	}
	if in.ToolChoice != nil {
		tc := *in.ToolChoice
		tc.Object = jsonclone.CloneMap(in.ToolChoice.Object)
		out.ToolChoice = &tc
	}
	out.ResponseFormatSchema = jsonclone.CloneMap(in.ResponseFormatSchema)
	if in.StructuredOutput != nil {
		structured := *in.StructuredOutput
		structured.Schema = cloneRaw(in.StructuredOutput.Schema)
		out.StructuredOutput = &structured
	}
	out.Stop = append([]string(nil), in.Stop...)
	out.Metadata = jsonclone.CloneMap(in.Metadata)
	out.Include = append([]string(nil), in.Include...)
	if in.ContextManagement != nil {
		contextManagement := *in.ContextManagement
		contextManagement.Edits = append([]ContextManagementEdit(nil), in.ContextManagement.Edits...)
		for i := range contextManagement.Edits {
			contextManagement.Edits[i].Value = cloneRaw(in.ContextManagement.Edits[i].Value)
		}
		out.ContextManagement = &contextManagement
	}
	out.MCPServers = jsonclone.CloneMapList(in.MCPServers)
	out.Images = append([]ImageReference(nil), in.Images...)
	out.TrailingReasoningItems = jsonclone.CloneMapList(in.TrailingReasoningItems)
	if in.ReasoningConfig != nil {
		rc := *in.ReasoningConfig
		out.ReasoningConfig = &rc
	}
	if in.Prediction != nil {
		prediction := *in.Prediction
		prediction.Content = cloneContentBlocks(in.Prediction.Content)
		out.Prediction = &prediction
	}
	if in.Operation.Compaction != nil {
		compaction, err := NewCompactionRequest(*in.Operation.Compaction)
		if err == nil {
			out.Operation.Compaction = compaction
		}
	}
	if in.ToolLedger != nil {
		ledger, err := NewToolOccurrenceLedger(in.ToolLedger.Occurrences())
		if err == nil {
			out.ToolLedger = ledger
		}
	}
	return &out
}

func cloneImage(in *ImageReference) *ImageReference {
	if in == nil {
		return nil
	}
	out := *in
	return &out
}

func requestSizeEstimate(req *NormalizedRequest) int {
	if req == nil {
		return 0
	}
	raw, err := json.Marshal(req)
	if err != nil {
		return 0
	}
	if len(raw) > contracts.MaxNativePayloadBytes {
		return contracts.MaxNativePayloadBytes
	}
	return len(raw)
}
