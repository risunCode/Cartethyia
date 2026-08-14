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
	prepared := &PrepareResult{Request: result.Request, Report: result.Report, Body: append([]byte(nil), body...)}
	prepared.Changed = !reflect.DeepEqual(request, result.Request)
	if !prepared.Changed {
		return prepared, nil
	}
	encoded, encodeErr := encoder.Encode(ctx, result.Request)
	if encodeErr != nil {
		return nil, encodeErr
	}
	merged, err := preserveUnknownJSON(body, encoded.Wire)
	if err != nil {
		return nil, newTransformError(CodeStageFailure, "encode-request", string(protocol), "body", "prepared request could not be encoded", err)
	}
	prepared.Body = merged
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
	merged, mergeErr := preserveUnknownJSON(originalBody, encoded.Wire)
	if mergeErr != nil {
		return nil, newTransformError(CodeStageFailure, "encode-request", string(protocol), "body", "prepared request could not be encoded", mergeErr)
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
	default:
		return nil, nil, false
	}
}

// preserveUnknownJSON overlays encoded known fields on the original JSON tree.
// Maps and aligned arrays merge recursively; fields with no canonical target
// therefore survive normalization without entering the canonical contract.
func preserveUnknownJSON(original []byte, encoded map[string]any) ([]byte, error) {
	if len(original) == 0 {
		return json.Marshal(encoded)
	}
	var raw any
	if err := json.Unmarshal(original, &raw); err != nil {
		return nil, err
	}
	encodedBytes, err := json.Marshal(encoded)
	if err != nil {
		return nil, err
	}
	var encodedTree any
	if err := json.Unmarshal(encodedBytes, &encodedTree); err != nil {
		return nil, err
	}
	merged := mergeUnknown(raw, encodedTree)
	return json.Marshal(merged)
}

func mergeUnknown(original, encoded any) any {
	om, ok := original.(map[string]any)
	em, encodedMap := encoded.(map[string]any)
	if ok && encodedMap {
		out := make(map[string]any, len(om)+len(em))
		for key, value := range em {
			if old, exists := om[key]; exists {
				out[key] = mergeUnknown(old, value)
			} else {
				out[key] = value
			}
		}
		for key, value := range om {
			if _, encodedExists := em[key]; !encodedExists && !knownCanonicalJSONKey(key) {
				out[key] = value
			}
		}
		return out
	}
	return encoded
}

func knownCanonicalJSONKey(key string) bool {
	switch key {
	case "model", "messages", "input", "instructions", "system", "tools", "tool_choice", "stream", "max_tokens", "max_output_tokens", "temperature", "top_p", "top_k", "stop", "stop_sequences", "response_format", "response_format_type", "reasoning", "metadata", "previous_response_id", "store", "parallel_tool_calls", "n", "user", "seed", "modalities", "audio", "prediction", "service_tier", "safety_identifier":
		return true
	default:
		return false
	}
}
