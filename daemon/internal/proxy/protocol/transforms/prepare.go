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
	prepared := &PrepareResult{Request: result.Request, Report: result.Report, Body: append([]byte(nil), body...), Sidecar: NewNativeSidecar(protocol)}
	prepared.Changed = !reflect.DeepEqual(request, result.Request)
	if !prepared.Changed {
		// Capture source-native fields even when canonical stages make no
		// semantic change. The original bytes remain authoritative, while the
		// exact-path sidecar is carried for a later target projection.
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
		return NewOpenAIChatRequestDecoder(), NewOpenAIChatCodec(), true
	case contracts.ProtocolOpenAIResponse:
		return NewOpenAIResponsesRequestDecoder(), NewOpenAIResponsesCodec(), true
	case contracts.ProtocolAnthropic:
		return NewAnthropicMessagesRequestDecoder(), NewAnthropicMessagesCodec(), true
	case contracts.ProtocolGemini:
		return NewGeminiRequestDecoder(), NewGeminiCodec(), true
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
