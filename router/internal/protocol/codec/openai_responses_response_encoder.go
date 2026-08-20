package codec

import (
	"context"
	"fmt"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// OpenAIResponsesResponseEncoder implements ResponseEncoder for the
// /v1/responses wire surface.
type OpenAIResponsesResponseEncoder struct{}

// NewOpenAIResponsesResponseEncoder constructs the encoder.
func NewOpenAIResponsesResponseEncoder() *OpenAIResponsesResponseEncoder {
	return &OpenAIResponsesResponseEncoder{}
}

// Protocol reports the wire surface.
func (e *OpenAIResponsesResponseEncoder) Protocol() contracts.Protocol {
	return contracts.ProtocolOpenAIResponse
}

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
	if len(response.Output) > 0 {
		out := make([]map[string]any, 0, len(response.Output))
		for _, block := range response.Output {
			switch block.Type {
			case BlockText:
				part := map[string]any{
					"type": "output_text",
					"text": block.Text,
				}
				if annotations := encodeAnnotations(block.Annotations); len(annotations) > 0 {
					part["annotations"] = annotations
				}
				out = append(out, map[string]any{
					"type": "message",
					"role": "assistant",
					"content": []map[string]any{part},
				})
			case BlockRefusal:
				text := ""
				if block.Refusal != nil {
					text = block.Refusal.Text
				}
				out = append(out, map[string]any{
					"type": "message",
					"role": "assistant",
					"content": []map[string]any{{"type": "refusal", "refusal": text}},
				})
			case BlockReasoning:
				out = append(out, encodeResponsesReasoningItem(block))
			case BlockToolUse:
				args := block.ToolArguments
				if args == "" {
					args = "{}"
				}
				item := map[string]any{
					"type":      "function_call",
					"call_id":   block.ToolCallID,
					"name":      block.ToolName,
					"arguments": args,
				}
				if block.ID != "" {
					item["id"] = block.ID
				}
				out = append(out, item)
			case BlockMediaOutput, BlockImage:
				if block.Media != nil {
					out = append(out, map[string]any{
						"type":  "message",
						"role":  "assistant",
						"content": []map[string]any{{
							"type":     "output_image",
							"image":    responseMediaValue(block.Media),
							"mime_type": block.Media.MIMEType,
						}},
					})
				}
			case BlockNative, BlockUnknown:
				if block.Raw != nil {
					out = append(out, cloneMap(block.Raw))
				}
			}
		}
		if len(out) > 0 {
			return out
		}
	}

	out := make([]map[string]any, 0, 1+len(response.ToolCalls))
	if response.Text != "" {
		out = append(out, map[string]any{
			"type": "message",
			"role": "assistant",
			"content": []map[string]any{{
				"type": "output_text",
				"text": response.Text,
			}},
		})
	}
	for _, event := range response.Events {
		switch event.Type {
		case EventReasoningDelta:
			if event.ReasoningText != "" {
				out = append(out, map[string]any{
					"type": "reasoning",
					"summary": []map[string]any{{"type": "summary_text", "text": event.ReasoningText}},
				})
			}
		case EventRefusalDelta:
			text := event.Text
			if event.Refusal != nil {
				text = event.Refusal.Text
			}
			out = append(out, map[string]any{
				"type": "message",
				"role": "assistant",
				"content": []map[string]any{{"type": "refusal", "refusal": text}},
			})
		case EventItemDone:
			if event.Media != nil {
				out = append(out, map[string]any{
					"type": "message",
					"role": "assistant",
					"content": []map[string]any{{"type": "output_image", "image": responseMediaValue(event.Media), "mime_type": event.Media.MIMEType}},
				})
			}
		}
	}
	for _, call := range response.ToolCalls {
		args := call.Arguments
		if args == "" {
			args = "{}"
		}
		item := map[string]any{
			"type":      "function_call",
			"call_id":   call.ID,
			"name":      call.Name,
			"arguments": args,
		}
		if call.ItemID != "" {
			item["id"] = call.ItemID
		}
		out = append(out, item)
	}
	return out
}

func encodeAnnotations(annotations []Annotation) []map[string]any {
	if len(annotations) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(annotations))
	for _, annotation := range annotations {
		if annotation.Citation.URL == "" && annotation.Citation.Title == "" && annotation.Citation.Text == "" {
			continue
		}
		item := map[string]any{"type": "url_citation", "url": annotation.Citation.URL, "title": annotation.Citation.Title}
		if annotation.Citation.Text != "" {
			item["text"] = annotation.Citation.Text
		}
		if start, ok := annotation.Citation.StartIndex.Get(); ok {
			item["start_index"] = start
		}
		if end, ok := annotation.Citation.EndIndex.Get(); ok {
			item["end_index"] = end
		}
		out = append(out, item)
	}
	return out
}

func encodeResponsesUsage(usage *Usage) map[string]any {
	if usage == nil {
		return nil
	}
	out := map[string]any{
		"input_tokens":  usage.InputTokens,
		"output_tokens": usage.OutputTokens,
		"total_tokens":  usage.TotalTokens,
	}
	if details := encodeInputUsageDetails(usage); len(details) > 0 {
		out["input_tokens_details"] = details
	}
	if details := encodeOutputUsageDetails(usage); len(details) > 0 {
		out["output_tokens_details"] = details
	}
	return out
}

// errEncodeResponseFallback is retained for symmetry with the shared error
// helper and is referenced by package-internal callers only.
var _ = fmt.Sprintf // keep fmt import alive if other files are stripped
