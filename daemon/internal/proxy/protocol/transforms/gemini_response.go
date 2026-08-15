package transforms

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// GeminiResponseDecoder implements ResponseDecoder for the native
// generateContent wire surface.
type GeminiResponseDecoder struct{}

// NewGeminiResponseDecoder constructs the decoder.
func NewGeminiResponseDecoder() *GeminiResponseDecoder { return &GeminiResponseDecoder{} }

// Protocol reports the wire surface.
func (d *GeminiResponseDecoder) Protocol() contracts.Protocol { return contracts.ProtocolGemini }

// Decode parses a non-stream Gemini response body into the canonical
// response model, preserving text, reasoning, tool calls, function
// responses, citations, media, usage, and lifecycle status.
func (d *GeminiResponseDecoder) Decode(ctx context.Context, body []byte, model string) (*NormalizedResponse, *TransformError) {
	if terr := requireContext(contracts.ProtocolGemini, ctx); terr != nil {
		return nil, terr
	}
	root, terr := decodeResponseBody(contracts.ProtocolGemini, body)
	if terr != nil {
		return nil, terr
	}
	response := &NormalizedResponse{
		Model:  model,
		Status: ItemStatusCompleted,
	}
	if candidates, ok := root["candidates"].([]any); ok {
		for i, raw := range candidates {
			candidate, ok := raw.(map[string]any)
			if !ok {
				return nil, errDecodeResponse(contracts.ProtocolGemini, fmt.Sprintf("candidates[%d]", i), "candidate must be an object")
			}
			if err := decodeGeminiCandidate(candidate, response, i); err != nil {
				return nil, err
			}
			if finishReason := responseString(candidate["finishReason"]); finishReason != "" {
				response.StopReason = stopReasonFromString(finishReason)
			}
		}
	}
	if usage, ok := root["usageMetadata"].(map[string]any); ok {
		parsed := responseUsage(map[string]any{
			"input_tokens":     usage["promptTokenCount"],
			"output_tokens":    usage["candidatesTokenCount"],
			"total_tokens":     usage["totalTokenCount"],
			"cached_tokens":    usage["cachedContentTokenCount"],
			"reasoning_tokens": usage["thoughtsTokenCount"],
		})
		response.Usage = &parsed
		emitUsage(response)
	}
	if response.Text != "" {
		response.Events = append(response.Events, NormalizedEvent{Type: EventTextDelta, Text: response.Text})
	}
	if response.StopReason != "" {
		finalizeResponse(response, response.StopReason, response.Status)
	}
	if response.Status == "" {
		response.Status = ItemStatusCompleted
	}
	return response, nil
}

// DecodeEvent maps a single Gemini stream frame into the canonical model.
// The transport aggregates frames before invoking this method.
func (d *GeminiResponseDecoder) DecodeEvent(ctx context.Context, frame []byte) (*NormalizedEvent, *TransformError) {
	if terr := requireContext(contracts.ProtocolGemini, ctx); terr != nil {
		return nil, terr
	}
	if len(frame) == 0 {
		return nil, errDecodeResponse(contracts.ProtocolGemini, "event", "stream frame is empty")
	}
	var payload map[string]any
	if err := json.Unmarshal(frame, &payload); err != nil {
		return nil, errDecodeResponse(contracts.ProtocolGemini, "event", "stream frame must be a JSON object")
	}
	if candidates, ok := payload["candidates"].([]any); ok && len(candidates) > 0 {
		if candidate, ok := candidates[0].(map[string]any); ok {
			if content, ok := candidate["content"].(map[string]any); ok {
				if parts, ok := content["parts"].([]any); ok {
					for _, raw := range parts {
						part, ok := raw.(map[string]any)
						if !ok {
							continue
						}
						if text := responseString(part["text"]); text != "" {
							return &NormalizedEvent{Type: EventTextDelta, Text: text}, nil
						}
						if thought := responseString(part["thought"]); thought != "" {
							return &NormalizedEvent{Type: EventReasoningDelta, ReasoningText: thought}, nil
						}
					}
				}
			}
			if reason := responseString(candidate["finishReason"]); reason != "" {
				return &NormalizedEvent{Type: EventResponseCompleted, Status: responseStatusFromStatus(reason)}, nil
			}
		}
	}
	return nil, nil
}

func decodeGeminiCandidate(candidate map[string]any, response *NormalizedResponse, index int) *TransformError {
	content, ok := candidate["content"].(map[string]any)
	if !ok {
		return errDecodeResponse(contracts.ProtocolGemini, fmt.Sprintf("candidates[%d].content", index), "content must be an object")
	}
	parts, ok := content["parts"].([]any)
	if !ok {
		return errDecodeResponse(contracts.ProtocolGemini, fmt.Sprintf("candidates[%d].content.parts", index), "parts must be an array")
	}
	for j, raw := range parts {
		part, ok := raw.(map[string]any)
		if !ok {
			return errDecodeResponse(contracts.ProtocolGemini, fmt.Sprintf("candidates[%d].content.parts[%d]", index, j), "part must be an object")
		}
		if err := decodeGeminiPart(part, response); err != nil {
			return err
		}
	}
	return nil
}

func decodeGeminiPart(part map[string]any, response *NormalizedResponse) *TransformError {
	if text := responseString(part["text"]); text != "" {
		response.Text += text
		return nil
	}
	if thought := responseString(part["thought"]); thought != "" {
		response.Events = append(response.Events, NormalizedEvent{Type: EventReasoningDelta, ReasoningText: thought})
		return nil
	}
	if fnCall, ok := part["functionCall"].(map[string]any); ok {
		id := responseString(fnCall["id"])
		name := responseString(fnCall["name"])
		args, _ := json.Marshal(fnCall["args"])
		response.ToolCalls = append(response.ToolCalls, NormalizedToolCall{ID: id, Name: name, Kind: ToolKindFunction, Arguments: string(args)})
		response.Events = append(response.Events, NormalizedEvent{Type: EventToolCallDelta, ToolCallID: id, ToolName: name, ToolArguments: string(args)})
		return nil
	}
	if fnResp, ok := part["functionResponse"].(map[string]any); ok {
		id := responseString(fnResp["id"])
		name := responseString(fnResp["name"])
		text, _ := json.Marshal(fnResp["response"])
		response.Events = append(response.Events, NormalizedEvent{Type: EventToolResult, ToolCallID: id, ToolName: name, Text: string(text)})
		return nil
	}
	if inline, ok := part["inlineData"].(map[string]any); ok {
		mime := responseString(inline["mimeType"])
		if mime == "" {
			mime = responseString(inline["mime_type"])
		}
		media := &MediaReference{Reference: ReferenceInlineData, MIMEType: mime, Value: responseString(inline["data"])}
		response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, Media: media})
		return nil
	}
	if file, ok := part["fileData"].(map[string]any); ok {
		uri := responseString(file["fileUri"])
		if uri == "" {
			uri = responseString(file["uri"])
		}
		media := &MediaReference{Reference: ReferenceProviderFileURL, MIMEType: responseString(file["mimeType"]), Value: uri}
		response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, Media: media})
		return nil
	}
	if ref, ok := part["citationMetadata"].(map[string]any); ok {
		if citations, ok := ref["citationSources"].([]any); ok {
			annotations := make([]Annotation, 0, len(citations))
			for _, raw := range citations {
				obj, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				citation := Citation{URL: responseString(obj["url"]), Title: responseString(obj["title"])}
				annotations = append(annotations, Annotation{Kind: AnnotationURLCitation, Citation: citation})
			}
			if len(annotations) > 0 {
				response.Events = append(response.Events, NormalizedEvent{Type: EventResponseCompleted, Annotations: annotations})
			}
		}
		return nil
	}
	return nil
}
