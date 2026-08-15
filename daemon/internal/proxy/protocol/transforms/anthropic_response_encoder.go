package transforms

import (
	"context"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
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
	content := encodeAnthropicOutputBlocks(response)
	payload := map[string]any{
		"id":            response.ID,
		"type":          "message",
		"role":          "assistant",
		"model":         response.Model,
		"content":       content,
		"stop_reason":   anthropicFinishReason(response.StopReason),
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
		delta := map[string]any{"type": "input_json_delta", "partial_json": event.ToolArguments}
		return map[string]any{"type": "content_block_delta", "index": 0, "delta": delta}, nil
	case EventItemDone:
		return map[string]any{"type": "content_block_stop", "index": 0}, nil
	case EventResponseCompleted:
		reason := "end_turn"
		switch event.Status {
		case ItemStatusIncomplete:
			reason = "max_tokens"
		case ItemStatusFailed:
			reason = "error"
		}
		return map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": reason}}, nil
	}
	return nil, nil
}

func encodeAnthropicOutputBlocks(response *NormalizedResponse) []map[string]any {
	if response == nil {
		return nil
	}
	if response.StopReason == "" && len(response.ToolCalls) > 0 {
		response.StopReason = StopToolCall
	}
	if response.Text != "" {
		return []map[string]any{{"type": "text", "text": response.Text}}
	}
	if len(response.ToolCalls) > 0 {
		out := make([]map[string]any, 0, len(response.ToolCalls))
		for _, call := range response.ToolCalls {
			input := []byte(call.Arguments)
			if len(input) == 0 {
				input = []byte("{}")
			}
			out = append(out, map[string]any{
				"type":  "tool_use",
				"id":    call.ID,
				"name":  call.Name,
				"input": input,
			})
		}
		return out
	}
	return []map[string]any{{"type": "text", "text": ""}}
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
