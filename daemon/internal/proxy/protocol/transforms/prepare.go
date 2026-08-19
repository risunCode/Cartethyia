package transforms

import (
	"context"
	"encoding/json"
	"reflect"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// PrepareResult is the bounded canonical request preparation result. Body is
// only rewritten when canonical stages changed known semantics; otherwise the
// caller's original JSON is retained byte-for-byte so provider-native fields
// remain untouched.
type PrepareResult struct {
	Request *NormalizedRequest
	Body    []byte
	Report  contracts.TransformReport
	Sidecar NativeSidecar
	Changed bool
}

// Request codecs contain no per-request state: Decode and Encode only read
// their arguments and allocate result values. Keep one instance per surface so
// normalization does not repeatedly allocate equivalent codec values; callers
// that need a concrete constructor remain free to use the public constructors.
var (
	openAIChatRequestDecoder      RequestDecoder = NewOpenAIChatRequestDecoder()
	openAIChatRequestEncoder      RequestEncoder = NewOpenAIChatCodec()
	openAIResponsesRequestDecoder RequestDecoder = NewOpenAIResponsesRequestDecoder()
	openAIResponsesRequestEncoder RequestEncoder = NewOpenAIResponsesCodec()
	anthropicRequestDecoder       RequestDecoder = NewAnthropicMessagesRequestDecoder()
	anthropicRequestEncoder       RequestEncoder = NewAnthropicMessagesCodec()
	geminiRequestDecoder          RequestDecoder = NewGeminiRequestDecoder()
	geminiRequestEncoder          RequestEncoder = NewGeminiCodec()
)

// NormalizeRequest decodes one supported client surface, runs the canonical
// lossless pipeline, and re-encodes only when a stage changed semantics. The
// default pipeline intentionally runs with LosslessOnly: lossy token saving is
// an explicit follow-up stage owned by the runtime.
func NormalizeRequest(ctx context.Context, protocol contracts.Protocol, body []byte, stream bool) (*PrepareResult, *TransformError) {
	decoder, encoder, ok := codecsFor(protocol)
	if !ok {
		return nil, newTransformError(CodeUnsupportedFeature, "decode-request", string(protocol), "protocol", "canonical normalization is unsupported for this surface", nil)
	}
	request, decodeErr := decoder.Decode(ctx, body, stream)
	if decodeErr != nil {
		return nil, decodeErr
	}
	pipeline, err := NewDefaultPipeline()
	if err != nil {
		return nil, newTransformError(CodeStageFailure, "pipeline", string(protocol), "pipeline", "canonical pipeline is unavailable", err)
	}
	result, err := pipeline.Apply(ctx, request, LosslessOnly)
	if err != nil {
		if transformErr, ok := err.(*TransformError); ok {
			return nil, transformErr
		}
		return nil, newTransformError(CodeStageFailure, "pipeline", string(protocol), "pipeline", "canonical pipeline failed", err)
	}
	prepared := &PrepareResult{Request: result.Request, Report: result.Report, Sidecar: NewNativeSidecar(protocol)}
	prepared.Changed = !reflect.DeepEqual(request, result.Request)
	if !prepared.Changed {
		// Capture source-native fields even when canonical stages make no
		// semantic change. The original bytes remain authoritative, while the
		// exact-path sidecar is carried for a later target projection. Copy the
		// caller's bytes because the prepared result owns Body after return.
		prepared.Body = append([]byte(nil), body...)
		encoded, encodeErr := encoder.Encode(ctx, result.Request)
		if encodeErr != nil {
			return nil, encodeErr
		}
		captured, captureErr := CaptureNativeSidecar(protocol, body, encoded.Wire)
		if captureErr != nil {
			return nil, captureErr
		}
		prepared.Sidecar = captured
		prepared.Request.Native = captured.Clone()
		return prepared, nil
	}
	encoded, encodeErr := encoder.Encode(ctx, result.Request)
	if encodeErr != nil {
		return nil, encodeErr
	}
	merged, sidecar, mergeErr := preserveNativeSidecarJSON(protocol, body, encoded.Wire)
	if mergeErr != nil {
		return nil, mergeErr
	}
	prepared.Body = merged
	prepared.Sidecar = sidecar
	prepared.Request.Native = sidecar.Clone()
	return prepared, nil
}

// NormalizeRequestSameSurface is the fast path for same-surface requests where
// the caller has already sanitized the body (e.g. via SanitizeSameSurfaceRequest).
// It validates JSON well-formedness, extracts the model for routing, and returns
// the body unchanged — skipping the full decode/pipeline/encode cycle.
//
// Use this when source and target protocols match and no cross-surface
// translation is needed. If the caller later needs to apply a lossy transform
// (e.g. token saver), EncodeNormalizedRequest will capture the sidecar from
// the original body at that point.
func NormalizeRequestSameSurface(ctx context.Context, protocol contracts.Protocol, body []byte, stream bool, model string) (*PrepareResult, *TransformError) {
	if !json.Valid(body) {
		return nil, newTransformError(CodeInvalidRequest, "fast-path", string(protocol), "body", "request body is not valid JSON", nil)
	}
	if model == "" {
		model = extractModelFromRaw(body)
	}
	if model == "" {
		return nil, newTransformError(CodeInvalidRequest, "fast-path", string(protocol), "model", "model is required", nil)
	}
	req := &NormalizedRequest{
		Model:  model,
		Stream: stream,
		Source: protocol,
		Native: NewNativeSidecar(protocol),
	}
	// Preserve body byte-for-byte. The sidecar is empty — if EncodeNormalizedRequest
	// is called later (e.g. by token saver), it falls through to
	// preserveNativeSidecarJSON which captures from the original body.
	return &PrepareResult{
		Request: req,
		Body:    append([]byte(nil), body...),
		Report:  contracts.TransformReport{},
		Sidecar: NewNativeSidecar(protocol),
		Changed: false,
	}, nil
}

// extractModelFromRaw extracts the "model" field from raw JSON without a full
// unmarshal. Returns empty string if not found.
func extractModelFromRaw(body []byte) string {
	var partial struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &partial); err != nil {
		return ""
	}
	return partial.Model
}

// EncodeNormalizedRequest renders a canonical request while preserving unknown
// provider-specific fields from originalBody. This is used after an explicit
// lossy stage (for example RTK token saving) changes canonical content.
func EncodeNormalizedRequest(ctx context.Context, protocol contracts.Protocol, req *NormalizedRequest, originalBody []byte) ([]byte, *TransformError) {
	_, encoder, ok := codecsFor(protocol)
	if !ok {
		return nil, newTransformError(CodeUnsupportedFeature, "encode-request", string(protocol), "protocol", "canonical encoding is unsupported for this surface", nil)
	}
	encoded, err := encoder.Encode(ctx, req)
	if err != nil {
		return nil, err
	}
	var merged []byte
	var mergeErr *TransformError
	if req != nil && len(req.Native.Fields) > 0 && req.Native.Source == protocol {
		var applied map[string]any
		applied, mergeErr = req.Native.ApplySameSurface(protocol, encoded.Wire)
		if mergeErr == nil {
			var marshalErr error
			merged, marshalErr = json.Marshal(applied)
			if marshalErr != nil {
				mergeErr = newTransformError(CodeStageFailure, "encode-request", string(protocol), "body", "prepared request could not be encoded", marshalErr)
			}
		}
	} else {
		merged, _, mergeErr = preserveNativeSidecarJSON(protocol, originalBody, encoded.Wire)
	}
	if mergeErr != nil {
		return nil, mergeErr
	}
	return merged, nil
}

func codecsFor(protocol contracts.Protocol) (RequestDecoder, RequestEncoder, bool) {
	switch protocol {
	case contracts.ProtocolOpenAIChat:
		return openAIChatRequestDecoder, openAIChatRequestEncoder, true
	case contracts.ProtocolOpenAIResponse:
		return openAIResponsesRequestDecoder, openAIResponsesRequestEncoder, true
	case contracts.ProtocolAnthropic:
		return anthropicRequestDecoder, anthropicRequestEncoder, true
	case contracts.ProtocolGemini:
		return geminiRequestDecoder, geminiRequestEncoder, true
	default:
		return nil, nil, false
	}
}

// preserveNativeSidecarJSON captures source extensions at exact paths and
// reapplies them only on the same source surface. Cross-surface callers must
// provide explicit pointer mappings through NativeSidecar.ApplyMapped.
func preserveNativeSidecarJSON(protocol contracts.Protocol, original []byte, encoded map[string]any) ([]byte, NativeSidecar, *TransformError) {
	sidecar, captureErr := CaptureNativeSidecar(protocol, original, encoded)
	if captureErr != nil {
		return nil, sidecar, captureErr
	}
	merged, applyErr := sidecar.ApplySameSurface(protocol, encoded)
	if applyErr != nil {
		return nil, sidecar, applyErr
	}
	body, err := json.Marshal(merged)
	if err != nil {
		return nil, sidecar, newTransformError(CodeStageFailure, "encode-request", string(protocol), "body", "prepared request could not be encoded", err)
	}
	return body, sidecar, nil
}
