package codec

import (
	"context"
	"encoding/json"
	"fmt"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// OpenAIResponsesResponseDecoder implements ResponseDecoder for the
// /v1/responses wire surface, including non-stream and stream frames.
type OpenAIResponsesResponseDecoder struct{}

// NewOpenAIResponsesResponseDecoder constructs the canonical decoder.
func NewOpenAIResponsesResponseDecoder() *OpenAIResponsesResponseDecoder {
	return &OpenAIResponsesResponseDecoder{}
}

// Protocol reports the wire surface.
func (d *OpenAIResponsesResponseDecoder) Protocol() contracts.Protocol {
	return contracts.ProtocolOpenAIResponse
}

// Decode parses a non-stream Responses body into a canonical
// NormalizedResponse. The decoder preserves IDs, indexes, output items,
// usage, refusal, annotations, media, tool lifecycle, and status.
func (d *OpenAIResponsesResponseDecoder) Decode(ctx context.Context, body []byte, model string) (*NormalizedResponse, *TransformError) {
	if terr := requireContext(contracts.ProtocolOpenAIResponse, ctx); terr != nil {
		return nil, terr
	}
	root, terr := decodeResponseBody(contracts.ProtocolOpenAIResponse, body)
	if terr != nil {
		return nil, terr
	}
	if _, hasOutput := root["output"]; !hasOutput {
		if _, hasStatus := root["status"]; !hasStatus {
			if _, hasID := root["id"]; !hasID {
				return nil, errDecodeResponse(contracts.ProtocolOpenAIResponse, "body", "response payload is not a Responses response")
			}
		}
	}
	wireModel := responseString(root["model"])
	if wireModel == "" {
		wireModel = model
	}
	if wireModel == "" {
		return nil, errDecodeResponse(contracts.ProtocolOpenAIResponse, "model", "response model is missing")
	}
	response := &NormalizedResponse{
		ID:                responseString(root["id"]),
		Model:             wireModel,
		ServiceTier:       responseString(root["service_tier"]),
		SystemFingerprint: responseString(root["system_fingerprint"]),
		Status:            responseStatusFromStatus(responseString(root["status"])),
	}
	if response.Status == "" {
		response.Status = ItemStatusCompleted
	}
	if seq, ok := responseInt(root["sequence_number"]); ok {
		response.SequenceNumber = Optional[int64]{presence: PresenceValue, value: int64(seq)}
	}
	if outputs, ok := root["output"].([]any); ok {
		for i, raw := range outputs {
			item, ok := raw.(map[string]any)
			if !ok {
				return nil, errDecodeResponse(contracts.ProtocolOpenAIResponse, fmt.Sprintf("output[%d]", i), "output item must be an object")
			}
			if err := decodeResponsesOutputItem(item, response); err != nil {
				return nil, err
			}
		}
	}
	if usage, ok := root["usage"].(map[string]any); ok {
		parsed := responseUsage(usage)
		response.Usage = &parsed
		emitUsage(response)
	}
	if status, ok := root["status"].(string); ok {
		if stop := stopReasonFromStatus(status); stop != "" {
			finalizeResponse(response, stop, response.Status)
		}
	}
	if response.Text != "" {
		response.Events = append(response.Events, NormalizedEvent{Type: EventTextDelta, Text: response.Text})
	}
	return response, nil
}

// DecodeEvent parses a single Responses stream event frame into the
// canonical lifecycle model. The transport aggregates frames before
// invoking this method.
func (d *OpenAIResponsesResponseDecoder) DecodeEvent(ctx context.Context, frame []byte) (*NormalizedEvent, *TransformError) {
	if terr := requireContext(contracts.ProtocolOpenAIResponse, ctx); terr != nil {
		return nil, terr
	}
	if len(frame) == 0 {
		return nil, errDecodeResponse(contracts.ProtocolOpenAIResponse, "event", "stream frame is empty")
	}
	var payload map[string]any
	if err := json.Unmarshal(frame, &payload); err != nil {
		return nil, errDecodeResponse(contracts.ProtocolOpenAIResponse, "event", "stream frame must be a JSON object")
	}
	typ := responseString(payload["type"])
	switch typ {
	case "response.output_text.delta":
		text := responseString(payload["delta"])
		return &NormalizedEvent{Type: EventTextDelta, Text: text}, nil
	case "response.reasoning_summary_text.delta":
		text := responseString(payload["delta"])
		return &NormalizedEvent{Type: EventReasoningDelta, ReasoningText: text}, nil
	case "response.refusal.delta":
		text := responseString(payload["delta"])
		return &NormalizedEvent{Type: EventRefusalDelta, Refusal: &RefusalContent{Text: text}}, nil
	case "response.function_call_arguments.delta":
		text := responseString(payload["delta"])
		itemID := responseString(payload["item_id"])
		return &NormalizedEvent{Type: EventToolCallDelta, ItemID: itemID, ToolArguments: text}, nil
	case "response.output_item.added", "response.output_item.done":
		item, _ := payload["item"].(map[string]any)
		if item == nil {
			return nil, nil
		}
		return decodeResponsesOutputItemEvent(item, typ)
	case "response.completed", "response.incomplete":
		status := ItemStatusCompleted
		if typ == "response.incomplete" {
			status = ItemStatusIncomplete
		}
		event := &NormalizedEvent{Type: EventResponseCompleted, Status: status}
		if response, ok := payload["response"].(map[string]any); ok {
			if usage, ok := response["usage"].(map[string]any); ok {
				parsed := responseUsage(usage)
				event.Usage = &parsed
			}
			event.ResponseID = responseString(response["id"])
		}
		return event, nil
	case "response.failed":
		return &NormalizedEvent{Type: EventError, Status: ItemStatusFailed}, nil
	}
	return nil, nil
}

func decodeResponsesOutputItem(item map[string]any, response *NormalizedResponse) *TransformError {
	typ := responseString(item["type"])
	itemID := responseString(item["id"])
	index, _ := responseInt(item["index"])
	switch typ {
	case "message":
		if err := decodeResponsesMessageItem(item, response, itemID, index); err != nil {
			return err
		}
	case "function_call":
		id := responseString(item["call_id"])
		if id == "" {
			id = itemID
		}
		name := responseString(item["name"])
		args := responseString(item["arguments"])
		kind := ToolKindFunction
		if responseString(item["type"]) == "custom_tool" {
			kind = ToolKindCustom
		}
		tc := NormalizedToolCall{ID: id, ItemID: itemID, Name: name, Kind: kind, Arguments: args, Index: Value(index)}
		response.ToolCalls = append(response.ToolCalls, tc)
		response.Output = append(response.Output, ContentBlock{Type: BlockToolUse, ID: itemID, Index: Value(index), ToolCallID: id, ToolName: name, ToolArguments: args, ToolKind: kind})
		response.Events = append(response.Events, NormalizedEvent{Type: EventToolCallDelta, ItemID: itemID, ToolCallID: id, ToolName: name, ToolArguments: args, Index: Value(index)})
	case "file_search_call", "web_search_call", "image_generation_call", "code_interpreter_call":
		id := responseString(item["call_id"])
		name := responseString(item["name"])
		args := responseString(item["arguments"])
		response.Events = append(response.Events, NormalizedEvent{Type: EventToolCallDelta, ItemID: itemID, ToolCallID: id, ToolName: name, ToolArguments: args, Index: Value(index)})
	case "compaction":
		encrypted := responseString(item["encrypted_content"])
		summary := responseString(item["summary"])
		if encrypted == "" && summary == "" {
			return errDecodeResponse(contracts.ProtocolOpenAIResponse, "output.compaction", "compaction item is empty")
		}
		response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, ItemID: itemID, ReasoningEncryptedContent: encrypted, Text: summary, Index: Value(index)})
	default:
		// Preserve unknown output items as native sidecar evidence so
		// encoders can round-trip same-surface extensions.
		response.Output = append(response.Output, ContentBlock{Type: BlockNative, ID: itemID, Index: Value(index), NativeType: typ, NativePayload: cloneMap(item), Raw: cloneMap(item)})
		response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, ItemID: itemID, Index: Value(index)})
	}
	return nil
}

func decodeResponsesMessageItem(item map[string]any, response *NormalizedResponse, itemID string, index int) *TransformError {
	var role Role
	if raw, ok := item["role"].(string); ok {
		role = Role(raw)
	}
	if role == "" {
		role = RoleAssistant
	}
	content, _ := item["content"].([]any)
	for j, raw := range content {
		block, ok := raw.(map[string]any)
		if !ok {
			return errDecodeResponse(contracts.ProtocolOpenAIResponse, fmt.Sprintf("content[%d]", j), "content block must be an object")
		}
		blockType := responseString(block["type"])
		switch blockType {
		case "output_text", "text":
			text := responseString(block["text"])
			if text != "" {
				response.Text += text
			}
			annotations := decodeAnnotations(block["annotations"])
			response.Output = append(response.Output, ContentBlock{Type: BlockText, ID: itemID, Index: Value(index), Text: text, Annotations: annotations})
			if len(annotations) > 0 {
				response.Events = append(response.Events, NormalizedEvent{Type: EventResponseCompleted, ItemID: itemID, Annotations: annotations})
			}
		case "refusal":
			refusal := responseString(block["refusal"])
			response.Output = append(response.Output, ContentBlock{Type: BlockRefusal, ID: itemID, Index: Value(index), Refusal: &RefusalContent{Text: refusal}})
			response.Events = append(response.Events, NormalizedEvent{Type: EventRefusalDelta, ItemID: itemID, Refusal: &RefusalContent{Text: refusal}, Index: Value(index)})
		case "output_image", "image":
			media := decodeResponsesMediaReference(block)
			if media != nil {
				response.Output = append(response.Output, ContentBlock{Type: BlockMediaOutput, ID: itemID, Index: Value(index), Media: media})
				response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, ItemID: itemID, Media: media, Index: Value(index)})
			}
		case "input_file", "file":
			media := decodeResponsesMediaReference(block)
			if media != nil {
				response.Output = append(response.Output, ContentBlock{Type: BlockFile, ID: itemID, Index: Value(index), Media: media})
				response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, ItemID: itemID, Media: media, Index: Value(index)})
			}
		case "reasoning_text":
			text := responseString(block["text"])
			response.Output = append(response.Output, ContentBlock{Type: BlockReasoning, ID: itemID, Index: Value(index), ReasoningText: text})
			response.Events = append(response.Events, NormalizedEvent{Type: EventReasoningDelta, ItemID: itemID, ReasoningText: text, Index: Value(index)})
		default:
			response.Output = append(response.Output, ContentBlock{Type: BlockNative, ID: itemID, Index: Value(index), NativeType: blockType, NativePayload: cloneMap(block), Raw: cloneMap(block)})
			response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, ItemID: itemID, Index: Value(index)})
		}
	}
	return nil
}

func decodeResponsesOutputItemEvent(item map[string]any, eventType string) (*NormalizedEvent, *TransformError) {
	typ := responseString(item["type"])
	itemID := responseString(item["id"])
	switch typ {
	case "message":
		return &NormalizedEvent{Type: EventItemDone, ItemID: itemID, Raw: cloneMap(item)}, nil
	case "function_call":
		return &NormalizedEvent{Type: EventToolCallDelta, ItemID: itemID, ToolCallID: responseString(item["call_id"]), ToolName: responseString(item["name"]), ToolArguments: responseString(item["arguments"]), Raw: cloneMap(item)}, nil
	}
	if eventType == "response.output_item.done" {
		return &NormalizedEvent{Type: EventItemDone, ItemID: itemID, Raw: cloneMap(item)}, nil
	}
	return &NormalizedEvent{Type: EventItemStart, ItemID: itemID, Raw: cloneMap(item)}, nil
}

func decodeResponsesMediaReference(block map[string]any) *MediaReference {
	if image, ok := block["image"].(string); ok && image != "" {
		return &MediaReference{Media: MediaImage, Reference: ReferenceInlineData, Value: image, MIMEType: responseString(block["mime_type"])}
	}
	if url, ok := block["file_url"].(string); ok && url != "" {
		return &MediaReference{Media: MediaGenericFile, Reference: ReferenceURL, Value: url, MIMEType: responseString(block["mime_type"])}
	}
	if fileID, ok := block["file_id"].(string); ok && fileID != "" {
		return &MediaReference{Media: MediaGenericFile, Reference: ReferenceProviderFileID, Value: fileID, MIMEType: responseString(block["mime_type"])}
	}
	if uri, ok := block["url"].(string); ok && uri != "" {
		return &MediaReference{Media: MediaImage, Reference: ReferenceURL, Value: uri, MIMEType: responseString(block["mime_type"])}
	}
	return nil
}
