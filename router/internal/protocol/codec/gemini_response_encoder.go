package codec

import (
	"context"
	"encoding/json"
	"fmt"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// GeminiResponseEncoder implements ResponseEncoder for the native
// generateContent wire surface.
type GeminiResponseEncoder struct{}

// NewGeminiResponseEncoder constructs the encoder.
func NewGeminiResponseEncoder() *GeminiResponseEncoder { return &GeminiResponseEncoder{} }

// Protocol reports the wire surface.
func (e *GeminiResponseEncoder) Protocol() contracts.Protocol { return contracts.ProtocolGemini }

// Encode renders a non-stream Gemini response body from a canonical
// NormalizedResponse, preserving ordered parts, function calls, function
// responses, inline media, citations, usage, and lifecycle status.
func (e *GeminiResponseEncoder) Encode(ctx context.Context, response *NormalizedResponse) (map[string]any, *TransformError) {
	if terr := requireContext(contracts.ProtocolGemini, ctx); terr != nil {
		return nil, terr
	}
	if terr := requireResponse(contracts.ProtocolGemini, response); terr != nil {
		return nil, terr
	}
	stopReason := response.StopReason
	if stopReason == "" && len(response.ToolCalls) > 0 {
		stopReason = StopToolCall
	}
	parts, terr := encodeGeminiResponseParts(response)
	if terr != nil {
		return nil, terr
	}
	candidate := map[string]any{
		"index":        0,
		"content":      map[string]any{"role": "model", "parts": parts},
		"finishReason": geminiFinishReason(stopReason, response.Status),
	}
	payload := map[string]any{
		"candidates":   []any{candidate},
		"modelVersion": response.Model,
	}
	if response.Usage != nil {
		payload["usageMetadata"] = map[string]any{
			"promptTokenCount":        response.Usage.InputTokens,
			"candidatesTokenCount":    response.Usage.OutputTokens,
			"totalTokenCount":         response.Usage.TotalTokens,
			"cachedContentTokenCount": response.Usage.CacheReadTokens,
			"thoughtsTokenCount":      response.Usage.ReasoningTokens,
		}
	}
	return payload, nil
}

// EncodeEvent renders a single Gemini stream frame.
func (e *GeminiResponseEncoder) EncodeEvent(ctx context.Context, event *NormalizedEvent) (map[string]any, *TransformError) {
	if terr := requireContext(contracts.ProtocolGemini, ctx); terr != nil {
		return nil, terr
	}
	if event == nil {
		return nil, errEncodeResponse(contracts.ProtocolGemini, "event", "event must not be nil")
	}
	switch event.Type {
	case EventResponseStart:
		return map[string]any{"candidates": []any{map[string]any{"index": eventIndex(event), "content": map[string]any{"role": "model", "parts": []map[string]any{}}}}}, nil
	case EventTextDelta:
		return map[string]any{
			"candidates": []any{map[string]any{
				"index":   eventIndex(event),
				"content": map[string]any{"role": "model", "parts": []map[string]any{{"text": event.Text}}},
			}},
		}, nil
	case EventReasoningDelta:
		return map[string]any{
			"candidates": []any{map[string]any{
				"index":   eventIndex(event),
				"content": map[string]any{"role": "model", "parts": []map[string]any{{"text": event.ReasoningText, "thought": true}}},
			}},
		}, nil
	case EventToolCallDelta:
		args := event.ToolArguments
		if args == "" {
			args = "{}"
		}
		var object map[string]any
		if err := json.Unmarshal([]byte(args), &object); err != nil || object == nil {
			return nil, newTransformError(CodeInvalidRequest, "encode-event", string(contracts.ProtocolGemini), "event.tool_arguments", "Gemini function arguments must be a JSON object", err)
		}
		call := map[string]any{"name": event.ToolName, "args": object}
		if event.ToolCallID != "" {
			call["id"] = event.ToolCallID
		}
		return map[string]any{
			"candidates": []any{map[string]any{
				"index":   eventIndex(event),
				"content": map[string]any{"role": "model", "parts": []map[string]any{{"functionCall": call}}},
			}},
		}, nil
	case EventToolResult:
		response := map[string]any{}
		if event.Text != "" {
			if err := json.Unmarshal([]byte(event.Text), &response); err != nil {
				response["result"] = event.Text
			}
		}
		call := map[string]any{"response": response}
		if event.ToolCallID != "" {
			call["id"] = event.ToolCallID
		}
		if event.ToolName != "" {
			call["name"] = event.ToolName
		}
		return map[string]any{
			"candidates": []any{map[string]any{
				"index":   eventIndex(event),
				"content": map[string]any{"role": "user", "parts": []map[string]any{{"functionResponse": call}}},
			}},
		}, nil
	case EventItemDone:
		if event.Media != nil {
			part := encodeGeminiResponseMedia(event.Media)
			return map[string]any{
				"candidates": []any{map[string]any{
					"index":   eventIndex(event),
					"content": map[string]any{"role": "model", "parts": []map[string]any{part}},
			}},
		}, nil
		}
		return nil, newTransformError(CodeUnsupportedFeature, "encode-event", string(contracts.ProtocolGemini), "event.type", "Gemini cannot represent an item completion without content", nil)
	case EventUsage:
		if event.Usage == nil {
			return nil, newTransformError(CodeInvalidRequest, "encode-event", string(contracts.ProtocolGemini), "event.usage", "usage event is missing usage data", nil)
		}
		return map[string]any{"usageMetadata": map[string]any{
			"promptTokenCount":     event.Usage.InputTokens,
			"candidatesTokenCount": event.Usage.OutputTokens,
			"totalTokenCount":      event.Usage.TotalTokens,
			"cachedContentTokenCount": event.Usage.CacheReadTokens,
			"thoughtsTokenCount":   event.Usage.ReasoningTokens,
		}}, nil
	case EventResponseCompleted:
		reason := "STOP"
		if event.StopReason != nil {
			reason = geminiFinishReason(*event.StopReason, event.Status)
		}
		switch event.Status {
		case ItemStatusIncomplete:
			reason = "MAX_TOKENS"
		case ItemStatusFailed:
			reason = "ERROR"
		}
		return map[string]any{
			"candidates": []any{map[string]any{
				"index":        eventIndex(event),
				"finishReason": reason,
			}},
		}, nil
	case EventError:
		return map[string]any{"candidates": []any{map[string]any{"index": eventIndex(event), "finishReason": "ERROR"}}}, nil
	default:
		return nil, newTransformError(CodeUnsupportedFeature, "encode-event", string(contracts.ProtocolGemini), "event.type", fmt.Sprintf("event %q is not representable on Gemini streaming", event.Type), nil)
	}
}

func eventIndex(event *NormalizedEvent) int {
	if event != nil {
		if index, ok := event.Index.Get(); ok {
			return index
	}
	}
	return 0
}

func encodeGeminiResponseMedia(media *MediaReference) map[string]any {
	if media == nil {
		return map[string]any{"inlineData": map[string]any{"mimeType": "application/octet-stream", "data": ""}}
	}
	if media.Reference == ReferenceInlineData {
		return map[string]any{"inlineData": map[string]any{"mimeType": media.MIMEType, "data": media.Value}}
	}
	return map[string]any{"fileData": map[string]any{"mimeType": media.MIMEType, "fileUri": media.Value}}
}

func encodeGeminiResponseParts(response *NormalizedResponse) ([]map[string]any, *TransformError) {
	if response == nil {
		return []map[string]any{{"text": ""}}, nil
	}
	parts := []map[string]any{}
	if response.Text != "" {
		parts = append(parts, map[string]any{"text": response.Text})
	}
	for _, call := range response.ToolCalls {
		args := map[string]any{}
		if call.Arguments != "" {
			if err := json.Unmarshal([]byte(call.Arguments), &args); err != nil || args == nil {
				return nil, newTransformError(CodeInvalidRequest, "encode-response", string(contracts.ProtocolGemini), "candidates[0].content.parts.functionCall.args", "tool arguments must be a JSON object", err)
			}
		}
		fnCall := map[string]any{"name": call.Name, "args": args}
		if call.ID != "" {
			fnCall["id"] = call.ID
		}
		parts = append(parts, map[string]any{"functionCall": fnCall})
	}
	for _, event := range response.Events {
		if event.Media != nil {
			parts = append(parts, map[string]any{"inlineData": map[string]any{"mimeType": event.Media.MIMEType, "data": event.Media.Value}})
		}
	}
	if len(parts) == 0 {
		parts = append(parts, map[string]any{"text": ""})
	}
	return parts, nil
}

func geminiFinishReason(reason StopReason, status ItemStatus) string {
	switch reason {
	case StopLength:
		return "MAX_TOKENS"
	case StopToolCall:
		return "TOOL_CODE"
	case StopContentFilter:
		return "SAFETY"
	case StopError:
		return "ERROR"
	}
	switch status {
	case ItemStatusIncomplete:
		return "MAX_TOKENS"
	case ItemStatusFailed:
		return "ERROR"
	case ItemStatusCanceled:
		return "OTHER"
	}
	return "STOP"
}
