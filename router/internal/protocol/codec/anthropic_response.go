package codec

import (
	"context"
	"encoding/json"
	"fmt"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// AnthropicMessagesResponseDecoder implements ResponseDecoder for the
// /v1/messages wire surface.
type AnthropicMessagesResponseDecoder struct{}

// NewAnthropicMessagesResponseDecoder constructs the decoder.
func NewAnthropicMessagesResponseDecoder() *AnthropicMessagesResponseDecoder {
	return &AnthropicMessagesResponseDecoder{}
}

// Protocol reports the wire surface.
func (d *AnthropicMessagesResponseDecoder) Protocol() contracts.Protocol {
	return contracts.ProtocolAnthropic
}

// Decode parses a non-stream Anthropic Messages body into a canonical
// NormalizedResponse, preserving text, reasoning, tool calls, server
// blocks, refusal, and usage.
func (d *AnthropicMessagesResponseDecoder) Decode(ctx context.Context, body []byte, model string) (*NormalizedResponse, *TransformError) {
	if terr := requireContext(contracts.ProtocolAnthropic, ctx); terr != nil {
		return nil, terr
	}
	root, terr := decodeResponseBody(contracts.ProtocolAnthropic, body)
	if terr != nil {
		return nil, terr
	}
	wireModel := responseString(root["model"])
	if wireModel == "" {
		wireModel = model
	}
	if wireModel == "" {
		return nil, errDecodeResponse(contracts.ProtocolAnthropic, "model", "response model is missing")
	}
	response := &NormalizedResponse{
		ID:     responseString(root["id"]),
		Model:  wireModel,
		Status: ItemStatusCompleted,
	}
	rawContent, ok := root["content"].([]any)
	if !ok {
		return nil, errDecodeResponse(contracts.ProtocolAnthropic, "content", "response content must be an array")
	}
	for i, raw := range rawContent {
		block, ok := raw.(map[string]any)
		if !ok {
			return nil, errDecodeResponse(contracts.ProtocolAnthropic, fmt.Sprintf("content[%d]", i), "content block must be an object")
		}
		if err := decodeAnthropicContentBlock(block, response, i); err != nil {
			return nil, err
		}
	}
	if usage, ok := root["usage"].(map[string]any); ok {
		parsed := responseUsage(usage)
		response.Usage = &parsed
		emitUsage(response)
	}
	stop := stopReasonFromString(responseString(root["stop_reason"]))
	finalizeResponse(response, stop, ItemStatusCompleted)
	if response.Text != "" {
		response.Events = append(response.Events, NormalizedEvent{Type: EventTextDelta, Text: response.Text})
	}
	return response, nil
}

// DecodeEvent maps a single Anthropic SSE event frame to a canonical
// lifecycle event. The transport aggregates frames before invoking.
func (d *AnthropicMessagesResponseDecoder) DecodeEvent(ctx context.Context, frame []byte) (*NormalizedEvent, *TransformError) {
	if terr := requireContext(contracts.ProtocolAnthropic, ctx); terr != nil {
		return nil, terr
	}
	if len(frame) == 0 {
		return nil, errDecodeResponse(contracts.ProtocolAnthropic, "event", "stream frame is empty")
	}
	var payload map[string]any
	if err := json.Unmarshal(frame, &payload); err != nil {
		return nil, errDecodeResponse(contracts.ProtocolAnthropic, "event", "stream frame must be a JSON object")
	}
	switch responseString(payload["type"]) {
	case "message_start":
		message, _ := payload["message"].(map[string]any)
		return &NormalizedEvent{Type: EventResponseStart, ResponseID: responseString(message["id"])}, nil
	case "content_block_start":
		block, _ := payload["content_block"].(map[string]any)
		if block == nil {
			return nil, nil
		}
		index := responseIndex(payload["index"])
		if responseString(block["type"]) == "tool_use" {
			return &NormalizedEvent{Type: EventToolCallDelta, ToolCallID: responseString(block["id"]), ToolName: responseString(block["name"]), Index: index}, nil
		}
		if media := decodeAnthropicImageSourceFromBlock(block); media != nil {
			return &NormalizedEvent{Type: EventItemDone, Media: media, Index: index}, nil
		}
		return nil, nil
	case "content_block_delta":
		delta, _ := payload["delta"].(map[string]any)
		if delta == nil {
			return nil, nil
		}
		index := responseIndex(payload["index"])
		switch responseString(delta["type"]) {
		case "text_delta":
			return &NormalizedEvent{Type: EventTextDelta, Text: responseString(delta["text"]), Index: index}, nil
		case "thinking_delta":
			return &NormalizedEvent{Type: EventReasoningDelta, ReasoningText: responseString(delta["thinking"]), Index: index}, nil
		case "signature_delta":
			return &NormalizedEvent{Type: EventItemDone, ReasoningSignature: responseString(delta["signature"]), Index: index}, nil
		case "input_json_delta":
			return &NormalizedEvent{Type: EventToolCallDelta, ToolArguments: responseString(delta["partial_json"]), Index: index}, nil
		}
	case "content_block_stop":
			return &NormalizedEvent{Type: EventItemDone, Index: responseIndex(payload["index"])}, nil
	case "message_delta":
		delta, _ := payload["delta"].(map[string]any)
		if delta != nil {
			if reason := responseString(delta["stop_reason"]); reason != "" {
					return &NormalizedEvent{Type: EventResponseCompleted, Status: anthropicStatusFromStopReason(reason), StopReason: stopReasonPointer(reason)}, nil
			}
		}
		if usage, ok := payload["usage"].(map[string]any); ok {
			parsed := responseUsage(usage)
			return &NormalizedEvent{Type: EventUsage, Usage: &parsed}, nil
		}
		return nil, nil
	case "message_stop":
		stop := StopCompleted
		return &NormalizedEvent{Type: EventResponseCompleted, Status: ItemStatusCompleted, StopReason: &stop}, nil
	case "error":
		text := responseString(payload["message"])
		if text == "" {
			if errObj, ok := payload["error"].(map[string]any); ok {
				text = responseString(errObj["message"])
			}
		}
		return &NormalizedEvent{Type: EventError, Status: ItemStatusFailed, Text: text}, nil
	}
	return nil, nil
}

func anthropicStatusFromStopReason(reason string) ItemStatus {
	switch stopReasonFromString(reason) {
	case StopLength:
		return ItemStatusIncomplete
	case StopError:
		return ItemStatusFailed
	default:
		return ItemStatusCompleted
	}
}

func responseIndex(value any) Optional[int] {
	if index, ok := responseInt(value); ok {
		return Value(index)
	}
	return Optional[int]{}
}

func decodeAnthropicImageSourceFromBlock(block map[string]any) *MediaReference {
	if source, ok := block["source"].(map[string]any); ok {
		return decodeAnthropicImageSource(source)
	}
	return nil
}

func decodeAnthropicContentBlock(block map[string]any, response *NormalizedResponse, index int) *TransformError {
	kind := responseString(block["type"])
	switch kind {
	case "text":
		text := responseString(block["text"])
		if text == "" {
			return errDecodeResponse(contracts.ProtocolAnthropic, fmt.Sprintf("content[%d].text", index), "text is missing")
		}
		response.Text += text
	case "thinking":
		text := responseString(block["thinking"])
		if text == "" {
			return errDecodeResponse(contracts.ProtocolAnthropic, fmt.Sprintf("content[%d].thinking", index), "thinking is missing")
		}
		response.Events = append(response.Events, NormalizedEvent{Type: EventReasoningDelta, ReasoningText: text, Index: Value(index)})
		if sig := responseString(block["signature"]); sig != "" {
			response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, Index: Value(index), ReasoningSignature: sig})
		}
	case "tool_use":
		id := responseString(block["id"])
		name := responseString(block["name"])
		if id == "" || name == "" {
			return errDecodeResponse(contracts.ProtocolAnthropic, fmt.Sprintf("content[%d]", index), "tool_use requires id and name")
		}
		args, err := json.Marshal(block["input"])
		if err != nil {
			return newTransformError(CodeInvalidRequest, "decode-response", string(contracts.ProtocolAnthropic), fmt.Sprintf("content[%d].input", index), "tool input is not encodable", err)
		}
		response.ToolCalls = append(response.ToolCalls, NormalizedToolCall{ID: id, Name: name, Kind: ToolKindFunction, Arguments: string(args), Index: Value(index)})
		response.Events = append(response.Events, NormalizedEvent{Type: EventToolCallDelta, ToolCallID: id, ToolName: name, ToolArguments: string(args), Index: Value(index)})
	case "tool_result":
		id := responseString(block["tool_use_id"])
		text := responseString(block["content"])
		response.Events = append(response.Events, NormalizedEvent{Type: EventToolResult, ToolCallID: id, Text: text, Index: Value(index)})
	case "server_tool_use", "web_search_tool_result", "code_execution_tool_result":
		// Surface server-side tool blocks as typed tool events. Encoders map
		// the kind onto the appropriate surface-specific representation.
		response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, Index: Value(index)})
	case "image":
		if source, ok := block["source"].(map[string]any); ok {
			if media := decodeAnthropicImageSource(source); media != nil {
				response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, Media: media, Index: Value(index)})
			}
		}
	case "document":
		if source, ok := block["source"].(map[string]any); ok {
			if media := decodeAnthropicImageSource(source); media != nil {
				response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, Media: media, Index: Value(index)})
			}
		}
	default:
		if kind == "" {
			return errDecodeResponse(contracts.ProtocolAnthropic, fmt.Sprintf("content[%d].type", index), "content type is missing")
		}
		response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, Index: Value(index)})
	}
	return nil
}

func decodeAnthropicImageSource(source map[string]any) *MediaReference {
	kind := responseString(source["type"])
	switch kind {
	case "base64":
		mime := responseString(source["media_type"])
		if mime == "" {
			mime = "image/png"
		}
		return &MediaReference{Reference: ReferenceInlineData, MIMEType: mime, Value: responseString(source["data"])}
	case "url":
		return &MediaReference{Reference: ReferenceURL, Value: responseString(source["url"])}
	case "file":
		return &MediaReference{Reference: ReferenceProviderFileID, Value: responseString(source["file_id"])}
	}
	return nil
}
