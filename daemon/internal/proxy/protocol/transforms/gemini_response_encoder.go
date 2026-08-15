package transforms

import (
	"context"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
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
	candidate := map[string]any{
		"index":        0,
		"content":      map[string]any{"role": "model", "parts": encodeGeminiResponseParts(response)},
		"finishReason": geminiFinishReason(response.StopReason, response.Status),
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
	case EventTextDelta:
		return map[string]any{
			"candidates": []any{map[string]any{
				"index":   0,
				"content": map[string]any{"role": "model", "parts": []map[string]any{{"text": event.Text}}},
			}},
		}, nil
	case EventReasoningDelta:
		return map[string]any{
			"candidates": []any{map[string]any{
				"index":   0,
				"content": map[string]any{"role": "model", "parts": []map[string]any{{"text": event.ReasoningText, "thought": true}}},
			}},
		}, nil
	case EventResponseCompleted:
		reason := "STOP"
		switch event.Status {
		case ItemStatusIncomplete:
			reason = "MAX_TOKENS"
		case ItemStatusFailed:
			reason = "ERROR"
		}
		return map[string]any{
			"candidates": []any{map[string]any{
				"index":        0,
				"finishReason": reason,
			}},
		}, nil
	}
	return nil, nil
}

func encodeGeminiResponseParts(response *NormalizedResponse) []map[string]any {
	if response == nil {
		return []map[string]any{{"text": ""}}
	}
	parts := []map[string]any{}
	if response.Text != "" {
		parts = append(parts, map[string]any{"text": response.Text})
	}
	for _, call := range response.ToolCalls {
		args := []byte(call.Arguments)
		if len(args) == 0 {
			args = []byte("{}")
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
	return parts
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
