package codec

import (
	"context"
	"encoding/json"
	"fmt"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// AnthropicMessagesResponseEncoder implements ResponseEncoder for the
// /v1/messages wire surface.
type AnthropicMessagesResponseEncoder struct{}

// NewAnthropicMessagesResponseEncoder constructs the encoder.
func NewAnthropicMessagesResponseEncoder() *AnthropicMessagesResponseEncoder {
	return &AnthropicMessagesResponseEncoder{}
}

// Protocol reports the wire surface.
func (e *AnthropicMessagesResponseEncoder) Protocol() contracts.Protocol {
	return contracts.ProtocolAnthropic
}

// Encode renders a non-stream Anthropic Messages body from a canonical
// NormalizedResponse.
func (e *AnthropicMessagesResponseEncoder) Encode(ctx context.Context, response *NormalizedResponse) (map[string]any, *TransformError) {
	if terr := requireContext(contracts.ProtocolAnthropic, ctx); terr != nil {
		return nil, terr
	}
	if terr := requireResponse(contracts.ProtocolAnthropic, response); terr != nil {
		return nil, terr
	}
	content, terr := encodeAnthropicOutputBlocks(response)
	if terr != nil {
		return nil, terr
	}
	stopReason := response.StopReason
	if stopReason == "" && len(response.ToolCalls) > 0 {
		stopReason = StopToolCall
	}
	payload := map[string]any{
		"id":            response.ID,
		"type":          "message",
		"role":          "assistant",
		"model":         response.Model,
		"content":       content,
		"stop_reason":   anthropicFinishReason(stopReason),
		"stop_sequence": nil,
	}
	if response.Usage != nil {
		payload["usage"] = map[string]any{
			"input_tokens":                response.Usage.InputTokens,
			"output_tokens":               response.Usage.OutputTokens,
			"cache_read_input_tokens":     response.Usage.CacheRead,
			"cache_creation_input_tokens": response.Usage.CacheWrite,
		}
	}
	return payload, nil
}

// EncodeEvent renders a single Anthropic stream frame.
func (e *AnthropicMessagesResponseEncoder) EncodeEvent(ctx context.Context, event *NormalizedEvent) (map[string]any, *TransformError) {
	if terr := requireContext(contracts.ProtocolAnthropic, ctx); terr != nil {
		return nil, terr
	}
	if event == nil {
		return nil, errEncodeResponse(contracts.ProtocolAnthropic, "event", "event must not be nil")
	}
	switch event.Type {
	case EventResponseStart:
		return map[string]any{"type": "message_start", "message": map[string]any{"id": event.ResponseID, "type": "message", "role": "assistant"}}, nil
	case EventTextDelta:
		return map[string]any{
			"type":  "content_block_delta",
			"index": 0,
			"delta": map[string]any{"type": "text_delta", "text": event.Text},
		}, nil
	case EventReasoningDelta:
		return map[string]any{
			"type":  "content_block_delta",
			"index": 0,
			"delta": map[string]any{"type": "thinking_delta", "thinking": event.ReasoningText},
		}, nil
	case EventToolCallDelta:
		index := 0
		if value, ok := event.Index.Get(); ok {
			index = value
		}
		if event.ToolArguments == "" && (event.ToolName != "" || event.ToolCallID != "") {
			return map[string]any{
				"type":  "content_block_start",
				"index": index,
				"content_block": map[string]any{
					"type": "tool_use",
					"id":   event.ToolCallID,
					"name": event.ToolName,
					"input": map[string]any{},
				},
			}, nil
		}
		delta := map[string]any{"type": "input_json_delta", "partial_json": event.ToolArguments}
		return map[string]any{"type": "content_block_delta", "index": index, "delta": delta}, nil
	case EventItemDone:
		index := 0
		if value, ok := event.Index.Get(); ok {
			index = value
		}
		return map[string]any{"type": "content_block_stop", "index": index}, nil
	case EventResponseCompleted:
		reason := StopCompleted
		if event.StopReason != nil {
			reason = *event.StopReason
		}
		wireReason := anthropicFinishReason(reason)
		if event.StopReason == nil {
			switch event.Status {
			case ItemStatusIncomplete:
				wireReason = "max_tokens"
			case ItemStatusFailed:
				wireReason = "error"
			}
		}
		return map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": wireReason}}, nil
	case EventUsage:
		if event.Usage == nil {
			return nil, errEncodeResponse(contracts.ProtocolAnthropic, "event.usage", "usage event is missing usage data")
		}
		return map[string]any{
			"type": "message_delta",
			"usage": map[string]any{
				"input_tokens":            event.Usage.InputTokens,
				"output_tokens":           event.Usage.OutputTokens,
				"cache_read_input_tokens": event.Usage.CacheReadTokens,
				"cache_creation_input_tokens": event.Usage.CacheWriteTokens,
			},
		}, nil
	case EventError:
		return map[string]any{"type": "error", "error": map[string]any{"type": "stream_error", "message": event.Text}}, nil
	default:
		return nil, newTransformError(CodeUnsupportedFeature, "encode-event", string(contracts.ProtocolAnthropic), "event.type", fmt.Sprintf("event %q is not representable on Anthropic Messages streaming", event.Type), nil)
	}
}

func encodeAnthropicOutputBlocks(response *NormalizedResponse) ([]map[string]any, *TransformError) {
	if response == nil {
		return nil, nil
	}
	if response.Text != "" {
		return []map[string]any{{"type": "text", "text": response.Text}}, nil
	}
	if len(response.ToolCalls) > 0 {
		out := make([]map[string]any, 0, len(response.ToolCalls))
		for i, call := range response.ToolCalls {
			raw := call.Arguments
			if raw == "" {
				raw = "{}"
			}
			var input map[string]any
			if err := json.Unmarshal([]byte(raw), &input); err != nil || input == nil {
				return nil, newTransformError(CodeInvalidRequest, "encode-response", string(contracts.ProtocolAnthropic), fmt.Sprintf("content[%d].input", i), "tool arguments must be a JSON object", err)
			}
			out = append(out, map[string]any{
				"type":  "tool_use",
				"id":    call.ID,
				"name":  call.Name,
				"input": input,
			})
		}
		return out, nil
	}
	return []map[string]any{{"type": "text", "text": ""}}, nil
}

func anthropicFinishReason(reason StopReason) string {
	switch reason {
	case StopLength:
		return "max_tokens"
	case StopToolCall:
		return "tool_use"
	case StopContentFilter:
		return "refusal"
	case StopError:
		return "error"
	default:
		return "end_turn"
	}
}
