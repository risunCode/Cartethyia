package transforms

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// OpenAIChatResponseDecoder implements ResponseDecoder for native
// /v1/chat/completions payloads.
type OpenAIChatResponseDecoder struct{}

// NewOpenAIChatResponseDecoder constructs a decoder for the OpenAI Chat
// Completions wire surface.
func NewOpenAIChatResponseDecoder() *OpenAIChatResponseDecoder { return &OpenAIChatResponseDecoder{} }

// Protocol reports the wire surface.
func (d *OpenAIChatResponseDecoder) Protocol() contracts.Protocol { return contracts.ProtocolOpenAIChat }

// Decode parses a non-streaming Chat Completions body into a canonical
// NormalizedResponse.
func (d *OpenAIChatResponseDecoder) Decode(ctx context.Context, body []byte, model string) (*NormalizedResponse, *TransformError) {
	if terr := requireContext(contracts.ProtocolOpenAIChat, ctx); terr != nil {
		return nil, terr
	}
	root, terr := decodeResponseBody(contracts.ProtocolOpenAIChat, body)
	if terr != nil {
		return nil, terr
	}
	wireModel := responseString(root["model"])
	if wireModel == "" {
		wireModel = model
	}
	if wireModel == "" {
		return nil, errDecodeResponse(contracts.ProtocolOpenAIChat, "model", "response model is missing")
	}
	response := &NormalizedResponse{
		ID:     responseString(root["id"]),
		Model:  wireModel,
		Status: ItemStatusCompleted,
	}
	if fingerprint := responseString(root["system_fingerprint"]); fingerprint != "" {
		response.SystemFingerprint = fingerprint
	}
	choices, ok := root["choices"].([]any)
	if !ok {
		return nil, errDecodeResponse(contracts.ProtocolOpenAIChat, "choices", "choices must be an array")
	}
	stop := StopCompleted
	for i, raw := range choices {
		choice, ok := raw.(map[string]any)
		if !ok {
			return nil, errDecodeResponse(contracts.ProtocolOpenAIChat, fmt.Sprintf("choices[%d]", i), "choice must be an object")
		}
		if err := decodeOpenAIChatChoice(choice, response, i); err != nil {
			return nil, err
		}
		if reason := responseString(choice["finish_reason"]); reason != "" {
			stop = stopReasonFromString(reason)
		}
	}
	if usage, ok := root["usage"].(map[string]any); ok {
		parsed := responseUsage(usage)
		response.Usage = &parsed
		emitUsage(response)
	}
	if response.Text != "" {
		response.Events = append(response.Events, NormalizedEvent{Type: EventTextDelta, Text: response.Text})
	}
	if len(response.ToolCalls) > 0 {
		for _, call := range response.ToolCalls {
			emitOpenAIToolCall(response, call)
		}
	}
	finalizeResponse(response, stop, ItemStatusCompleted)
	return response, nil
}

// DecodeEvent parses a single OpenAI Chat streaming chunk into canonical
// events. The transport aggregates frames before invoking this method.
func (d *OpenAIChatResponseDecoder) DecodeEvent(ctx context.Context, frame []byte) (*NormalizedEvent, *TransformError) {
	if terr := requireContext(contracts.ProtocolOpenAIChat, ctx); terr != nil {
		return nil, terr
	}
	if len(frame) == 0 {
		return nil, errDecodeResponse(contracts.ProtocolOpenAIChat, "event", "stream frame is empty")
	}
	var chunk map[string]any
	if err := json.Unmarshal(frame, &chunk); err != nil {
		return nil, errDecodeResponse(contracts.ProtocolOpenAIChat, "event", "stream frame must be a JSON object")
	}
	return decodeOpenAIChatChunk(chunk)
}

func decodeOpenAIChatChoice(choice map[string]any, response *NormalizedResponse, index int) *TransformError {
	indexValue, _ := responseInt(choice["index"])
	message, ok := choice["message"].(map[string]any)
	if !ok {
		return errDecodeResponse(contracts.ProtocolOpenAIChat, fmt.Sprintf("choices[%d].message", index), "message must be an object")
	}
	if content := responseString(message["content"]); content != "" {
		response.Text += content
	}
	if reasoning := responseString(message["reasoning_content"]); reasoning != "" {
		response.Events = append(response.Events, NormalizedEvent{Type: EventReasoningDelta, ReasoningText: reasoning, Index: Value(indexValue)})
	}
	if refusal := responseString(message["refusal"]); refusal != "" {
		response.Events = append(response.Events, NormalizedEvent{Type: EventRefusalDelta, Refusal: &RefusalContent{Text: refusal}, Index: Value(indexValue)})
	}
	if annotations := decodeAnnotations(message["annotations"]); len(annotations) > 0 {
		response.Events = append(response.Events, NormalizedEvent{Type: EventResponseCompleted, Annotations: annotations})
	}
	if calls, ok := message["tool_calls"].([]any); ok {
		if err := decodeOpenAIToolCalls(calls, response); err != nil {
			return err
		}
	}
	if audio, ok := message["audio"].(map[string]any); ok {
		if media, ok := audio["data"].(string); ok && media != "" {
			mime := responseString(audio["format"])
			if mime == "" {
				mime = "audio/wav"
			}
			response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, Media: &MediaReference{Reference: ReferenceInlineData, MIMEType: mime, Value: media}})
		}
	}
	return nil
}

func decodeOpenAIToolCalls(raw []any, response *NormalizedResponse) *TransformError {
	for i, rawCall := range raw {
		call, ok := rawCall.(map[string]any)
		if !ok {
			return errDecodeResponse(contracts.ProtocolOpenAIChat, fmt.Sprintf("tool_calls[%d]", i), "tool call must be an object")
		}
		fn, _ := call["function"].(map[string]any)
		name := responseString(fn["name"])
		args := responseString(fn["arguments"])
		if args == "" {
			args = "{}"
		}
		id := responseString(call["id"])
		kind := ToolKindFunction
		if responseString(call["type"]) == "custom_tool" {
			kind = ToolKindCustom
		}
		tc := NormalizedToolCall{ID: id, Name: name, Kind: kind, Arguments: args, ItemID: responseString(call["item_id"])}
		response.ToolCalls = append(response.ToolCalls, tc)
	}
	return nil
}

func emitOpenAIToolCall(response *NormalizedResponse, call NormalizedToolCall) {
	if response == nil {
		return
	}
	if call.ID != "" || call.Name != "" {
		response.Events = append(response.Events, NormalizedEvent{Type: EventToolCallDelta, ToolCallID: call.ID, ToolName: call.Name})
	}
	if call.Arguments != "" {
		response.Events = append(response.Events, NormalizedEvent{Type: EventToolCallDelta, ToolCallID: call.ID, ToolArguments: call.Arguments})
	}
	response.Events = append(response.Events, NormalizedEvent{Type: EventItemDone, ToolCallID: call.ID})
}

func decodeAnnotations(raw any) []Annotation {
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]Annotation, 0, len(items))
	for _, value := range items {
		obj, ok := value.(map[string]any)
		if !ok {
			continue
		}
		citation := Citation{URL: responseString(obj["url"]), Title: responseString(obj["title"]), Text: responseString(obj["text"])}
		if start, ok := responseInt(obj["start_index"]); ok {
			citation.StartIndex = ValueOf(start)
		}
		if end, ok := responseInt(obj["end_index"]); ok {
			citation.EndIndex = ValueOf(end)
		}
		out = append(out, Annotation{Kind: AnnotationURLCitation, Citation: citation})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// OpenAIChatStreamDecoder incrementally maps one Chat Completions chunk to
// a single canonical event. The transport aggregates frames before invoking
// the codec.
type OpenAIChatStreamDecoder struct {
	providerID string
}

// NewOpenAIChatStreamDecoder constructs an empty stream decoder.
func NewOpenAIChatStreamDecoder(providerID string) *OpenAIChatStreamDecoder {
	return &OpenAIChatStreamDecoder{providerID: providerID}
}

// Decode returns the canonical event for a single resolved Chat chunk.
func (d *OpenAIChatStreamDecoder) Decode(ctx context.Context, frame []byte) (*NormalizedEvent, error) {
	if d == nil {
		return nil, fmt.Errorf("chat stream decoder is nil")
	}
	if len(frame) == 0 {
		return nil, nil
	}
	var chunk map[string]any
	if err := json.Unmarshal(frame, &chunk); err != nil {
		return nil, fmt.Errorf("%s: chunk is not valid JSON", d.providerID)
	}
	event, _ := decodeOpenAIChatChunk(chunk)
	return event, nil
}

func decodeOpenAIChatChunk(chunk map[string]any) (*NormalizedEvent, *TransformError) {
	choices, _ := chunk["choices"].([]any)
	if len(choices) == 0 {
		return nil, nil
	}
	choice, _ := choices[0].(map[string]any)
	if choice == nil {
		return nil, nil
	}
	delta, _ := choice["delta"].(map[string]any)
	if delta == nil {
		return nil, nil
	}
	if text := responseString(delta["content"]); text != "" {
		return &NormalizedEvent{Type: EventTextDelta, Text: text}, nil
	}
	if reason := responseString(delta["reasoning_content"]); reason != "" {
		return &NormalizedEvent{Type: EventReasoningDelta, ReasoningText: reason}, nil
	}
	if refusal := responseString(delta["refusal"]); refusal != "" {
		return &NormalizedEvent{Type: EventRefusalDelta, Refusal: &RefusalContent{Text: refusal}}, nil
	}
	if calls, ok := delta["tool_calls"].([]any); ok && len(calls) > 0 {
		call, _ := calls[0].(map[string]any)
		if call == nil {
			return nil, nil
		}
		fn, _ := call["function"].(map[string]any)
		id := responseString(call["id"])
		name := responseString(fn["name"])
		args := responseString(fn["arguments"])
		if id == "" && name == "" && args == "" {
			return nil, nil
		}
		return &NormalizedEvent{Type: EventToolCallDelta, ToolCallID: id, ToolName: name, ToolArguments: args}, nil
	}
	return nil, nil
}

func ValueOf(v int) Optional[int] { return Optional[int]{presence: PresenceValue, value: v} }
