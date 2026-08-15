package transforms

import (
	"context"
	"fmt"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// OpenAIResponsesResponseEncoder implements ResponseEncoder for the
// /v1/responses wire surface.
type OpenAIResponsesResponseEncoder struct{}

// NewOpenAIResponsesResponseEncoder constructs the encoder.
func NewOpenAIResponsesResponseEncoder() *OpenAIResponsesResponseEncoder { return &OpenAIResponsesResponseEncoder{} }

// Protocol reports the wire surface.
func (e *OpenAIResponsesResponseEncoder) Protocol() contracts.Protocol { return contracts.ProtocolOpenAIResponse }

// Encode renders a non-stream Responses body from a canonical
// NormalizedResponse, preserving ordered output items, IDs, indexes,
// tool calls, refusal, reasoning, media, usage, and status.
func (e *OpenAIResponsesResponseEncoder) Encode(ctx context.Context, response *NormalizedResponse) (map[string]any, *TransformError) {
	if terr := requireContext(contracts.ProtocolOpenAIResponse, ctx); terr != nil {
		return nil, terr
	}
	if terr := requireResponse(contracts.ProtocolOpenAIResponse, response); terr != nil {
		return nil, terr
	}
	payload := map[string]any{
		"id":     response.ID,
		"object": "response",
		"model":  response.Model,
		"status": responsesStatus(response.Status),
	}
	if response.SystemFingerprint != "" {
		payload["system_fingerprint"] = response.SystemFingerprint
	}
	if response.ServiceTier != "" {
		payload["service_tier"] = response.ServiceTier
	}
	if seq, has := response.SequenceNumber.Get(); has {
		payload["sequence_number"] = seq
	}
	output := encodeResponsesOutput(response)
	if len(output) > 0 {
		payload["output"] = output
	}
	if response.Usage != nil {
		payload["usage"] = encodeResponsesUsage(response.Usage)
	}
	return payload, nil
}

// EncodeEvent renders a Responses stream event frame.
func (e *OpenAIResponsesResponseEncoder) EncodeEvent(ctx context.Context, event *NormalizedEvent) (map[string]any, *TransformError) {
	if terr := requireContext(contracts.ProtocolOpenAIResponse, ctx); terr != nil {
		return nil, terr
	}
	if event == nil {
		return nil, errEncodeResponse(contracts.ProtocolOpenAIResponse, "event", "event must not be nil")
	}
	switch event.Type {
	case EventTextDelta:
		return map[string]any{"type": "response.output_text.delta", "delta": event.Text, "item_id": event.ItemID}, nil
	case EventReasoningDelta:
		return map[string]any{"type": "response.reasoning_summary_text.delta", "delta": event.ReasoningText, "item_id": event.ItemID}, nil
	case EventRefusalDelta:
		text := event.Text
		if event.Refusal != nil {
			text = event.Refusal.Text
		}
		return map[string]any{"type": "response.refusal.delta", "delta": text, "item_id": event.ItemID}, nil
	case EventToolCallDelta:
		return map[string]any{"type": "response.function_call_arguments.delta", "delta": event.ToolArguments, "item_id": event.ItemID, "call_id": event.ToolCallID, "name": event.ToolName}, nil
	case EventItemStart, EventItemDone:
		item := map[string]any{"type": "message", "role": "assistant", "id": event.ItemID}
		return map[string]any{"type": "response.output_item.added", "item": item, "output_index": 0}, nil
	case EventUsage:
		if event.Usage == nil {
			return nil, nil
		}
		return map[string]any{"type": "response.completed", "response": map[string]any{"usage": encodeResponsesUsage(event.Usage)}}, nil
	case EventResponseCompleted:
		reason := "completed"
		switch event.Status {
		case ItemStatusIncomplete:
			reason = "incomplete"
		case ItemStatusFailed:
			reason = "failed"
		}
		return map[string]any{"type": "response." + reason}, nil
	}
	return nil, nil
}

func responsesStatus(status ItemStatus) string {
	switch status {
	case ItemStatusCompleted:
		return "completed"
	case ItemStatusIncomplete:
		return "incomplete"
	case ItemStatusFailed:
		return "failed"
	case ItemStatusCanceled:
		return "canceled"
	}
	return "completed"
}

func encodeResponsesOutput(response *NormalizedResponse) []map[string]any {
	if response == nil {
		return nil
	}
	if response.StopReason == "" && len(response.ToolCalls) > 0 {
		response.StopReason = StopToolCall
	}
	if response.Text != "" {
		return []map[string]any{{
			"type": "message",
			"role": "assistant",
			"content": []map[string]any{{
				"type": "output_text",
				"text": response.Text,
			}},
		}}
	}
	if len(response.ToolCalls) > 0 {
		out := make([]map[string]any, 0, len(response.ToolCalls))
		for _, call := range response.ToolCalls {
			args := call.Arguments
			if args == "" {
				args = "{}"
			}
			out = append(out, map[string]any{
				"type":      "function_call",
				"id":        call.ItemID,
				"call_id":   call.ID,
				"name":      call.Name,
				"arguments": args,
			})
		}
		return out
	}
	return nil
}

func encodeResponsesUsage(usage *Usage) map[string]any {
	if usage == nil {
		return nil
	}
	return map[string]any{
		"input_tokens":  usage.InputTokens,
		"output_tokens": usage.OutputTokens,
		"total_tokens":  usage.TotalTokens,
		"input_tokens_details": map[string]any{
			"cached_tokens": usage.CacheReadTokens,
		},
		"output_tokens_details": map[string]any{
			"reasoning_tokens": usage.ReasoningTokens,
		},
	}
}

// errEncodeResponseFallback is retained for symmetry with the shared error
// helper and is referenced by package-internal callers only.
var _ = fmt.Sprintf // keep fmt import alive if other files are stripped
