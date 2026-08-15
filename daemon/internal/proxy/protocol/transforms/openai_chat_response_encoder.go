package transforms

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// OpenAIChatResponseEncoder implements ResponseEncoder for the
// /v1/chat/completions wire surface.
type OpenAIChatResponseEncoder struct{}

// NewOpenAIChatResponseEncoder constructs the encoder.
func NewOpenAIChatResponseEncoder() *OpenAIChatResponseEncoder { return &OpenAIChatResponseEncoder{} }

// Protocol reports the wire surface.
func (e *OpenAIChatResponseEncoder) Protocol() contracts.Protocol {
	return contracts.ProtocolOpenAIChat
}

// Encode renders a non-stream Chat Completions body from a canonical
// NormalizedResponse, preserving text, reasoning, refusal, tool calls,
// usage, and lifecycle status.
func (e *OpenAIChatResponseEncoder) Encode(ctx context.Context, response *NormalizedResponse) (map[string]any, *TransformError) {
	if terr := requireContext(contracts.ProtocolOpenAIChat, ctx); terr != nil {
		return nil, terr
	}
	if terr := requireResponse(contracts.ProtocolOpenAIChat, response); terr != nil {
		return nil, terr
	}
	if response.StopReason == "" && len(response.ToolCalls) > 0 {
		response.StopReason = StopToolCall
	}
	payload := map[string]any{
		"id":      response.ID,
		"object":  "chat.completion",
		"model":   response.Model,
		"created": 0,
	}
	if response.SystemFingerprint != "" {
		payload["system_fingerprint"] = response.SystemFingerprint
	}
	if response.ServiceTier != "" {
		payload["service_tier"] = response.ServiceTier
	}
	choice := map[string]any{
		"index": 0,
		"message": map[string]any{
			"role":    "assistant",
			"content": response.Text,
		},
		"finish_reason": chatFinishReason(response.StopReason),
	}
	if reasoning := collectReasoningText(response); reasoning != "" {
		choice["message"].(map[string]any)["reasoning_content"] = reasoning
	}
	if refusal := collectRefusalText(response); refusal != "" {
		choice["message"].(map[string]any)["refusal"] = refusal
	}
	if calls := encodeChatToolCalls(response); len(calls) > 0 {
		choice["message"].(map[string]any)["tool_calls"] = calls
	}
	if response.Usage != nil {
		payload["usage"] = encodeChatUsage(response.Usage)
	}
	payload["choices"] = []any{choice}
	return payload, nil
}

// EncodeEvent renders a Chat Completions streaming chunk from a canonical
// event.
func (e *OpenAIChatResponseEncoder) EncodeEvent(ctx context.Context, event *NormalizedEvent) (map[string]any, *TransformError) {
	if terr := requireContext(contracts.ProtocolOpenAIChat, ctx); terr != nil {
		return nil, terr
	}
	if event == nil {
		return nil, errEncodeResponse(contracts.ProtocolOpenAIChat, "event", "event must not be nil")
	}
	switch event.Type {
	case EventTextDelta:
		return map[string]any{"object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": event.Text}}}}, nil
	case EventReasoningDelta:
		return map[string]any{"object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"reasoning_content": event.ReasoningText}}}}, nil
	case EventRefusalDelta:
		text := event.Text
		if event.Refusal != nil {
			text = event.Refusal.Text
		}
		return map[string]any{"object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"refusal": text}}}}, nil
	case EventToolCallDelta:
		return map[string]any{"object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"id": event.ToolCallID, "type": "function", "function": map[string]any{"name": event.ToolName, "arguments": event.ToolArguments}}}}}}}, nil
	case EventResponseCompleted:
		return map[string]any{"object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "finish_reason": chatFinishReason(responseStop(event.StopReason))}}}, nil
	}
	return nil, nil
}

func chatFinishReason(reason StopReason) string {
	switch reason {
	case StopToolCall:
		return "tool_calls"
	case StopLength:
		return "length"
	case StopContentFilter:
		return "content_filter"
	case StopError:
		return "error"
	default:
		return "stop"
	}
}

func responseStop(reason *StopReason) StopReason {
	if reason == nil {
		return StopCompleted
	}
	return *reason
}

func encodeChatToolCalls(response *NormalizedResponse) []map[string]any {
	if response == nil || len(response.ToolCalls) == 0 {
		return nil
	}
	if response.StopReason == "" {
		response.StopReason = StopToolCall
	}
	out := make([]map[string]any, 0, len(response.ToolCalls))
	for _, call := range response.ToolCalls {
		args := call.Arguments
		if args == "" {
			args = "{}"
		}
		out = append(out, map[string]any{
			"id":       call.ID,
			"type":     "function",
			"function": map[string]any{"name": call.Name, "arguments": args},
		})
	}
	return out
}

func encodeChatUsage(usage *Usage) map[string]any {
	if usage == nil {
		return nil
	}
	return map[string]any{
		"prompt_tokens":     usage.InputTokens,
		"completion_tokens": usage.OutputTokens,
		"total_tokens":      usage.TotalTokens,
	}
}

func collectReasoningText(response *NormalizedResponse) string {
	if response == nil {
		return ""
	}
	for _, event := range response.Events {
		if event.Type == EventReasoningDelta {
			return event.ReasoningText
		}
	}
	return ""
}

func collectRefusalText(response *NormalizedResponse) string {
	if response == nil {
		return ""
	}
	for _, event := range response.Events {
		if event.Type == EventRefusalDelta {
			if event.Refusal != nil {
				return event.Refusal.Text
			}
			return event.Text
		}
	}
	return ""
}

// MarshalResponse encodes the canonical response to a wire-format JSON
// body. The transport layer is responsible for the final write into the
// HTTP response stream.
func MarshalResponse(surface contracts.Protocol, payload map[string]any) ([]byte, *TransformError) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, errEncodeResponse(surface, "body", fmt.Sprintf("response marshal failed: %v", err))
	}
	return body, nil
}
