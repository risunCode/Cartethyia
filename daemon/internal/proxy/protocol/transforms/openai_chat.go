package transforms

import (
	"context"
	"fmt"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/jsonclone"
)

// OpenAIChatCodec implements request encoding for the OpenAI Chat
// Completions wire surface. Decoding is handled by OpenAIChatRequestDecoder.
type OpenAIChatCodec struct{}

// NewOpenAIChatCodec constructs a chat encoder.
func NewOpenAIChatCodec() *OpenAIChatCodec { return &OpenAIChatCodec{} }

// Protocol reports the wire surface.
func (c *OpenAIChatCodec) Protocol() contracts.Protocol { return contracts.ProtocolOpenAIChat }

// Encode projects a canonical request onto /v1/chat/completions.
//
// Stream handling: when req.Stream is true the encoder emits `stream: true`
// and the `stream_options.include_usage` hint used by upstream providers
// to attach a final usage chunk. The flag is never silently dropped; if
// the caller sets Stream = false the encoder emits `stream: false`.
//
// Unknown fields: any key on req.Metadata or anything routed through the
// generic extension bucket is forwarded as a passthrough field rather
// than discarded. Encoders cannot drop a wire field without an explicit
// DispositionUnsupported entry.
func (c *OpenAIChatCodec) Encode(ctx context.Context, req *NormalizedRequest) (*EncoderResult, *TransformError) {
	if err := ctx.Err(); err != nil {
		return nil, newTransformError(CodeContextCanceled, "encode-request", string(contracts.ProtocolOpenAIChat), "context", "transform canceled", err)
	}
	if req == nil {
		return nil, errEncode(contracts.ProtocolOpenAIChat, "request", "request must not be nil")
	}
	if err := req.Validate(); err != nil {
		return nil, errEncode(contracts.ProtocolOpenAIChat, "request", err.Error())
	}
	if field := firstUnsupportedChatMedia(req.Messages); field != "" {
		return nil, newTransformError(CodeUnsupportedFeature, "encode-request", string(contracts.ProtocolOpenAIChat), field, "Chat target does not represent this media reference", nil)
	}

	payload := map[string]any{
		"model":    req.Model,
		"stream":   req.Stream,
		"messages": encodeChatMessages(req.Messages),
	}
	var disp []FieldDisposition

	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			if t.NativeType != "" {
				return nil, errEncode(contracts.ProtocolOpenAIChat, "tools", fmt.Sprintf("native tool %q not supported on chat", t.NativeType))
			}
			tools = append(tools, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        t.Name,
					"description": nilIfEmpty(t.Description),
					"parameters":  t.InputSchema,
				},
			})
		}
		payload["tools"] = tools
		disp = append(disp, FieldDisposition{Path: "tools", Action: DispositionAdapted, Reason: "function tools"})
	}

	if req.MaxOutputTokens != nil {
		// OpenAI Chat accepts both `max_tokens` and `max_completion_tokens`.
		// Newer models require the latter; the encoder always emits the
		// completion-token alias so behavior is consistent across runtimes.
		payload["max_completion_tokens"] = *req.MaxOutputTokens
		disp = append(disp, FieldDisposition{Path: "max_output_tokens", Action: DispositionAdapted, TargetPath: "max_completion_tokens", Reason: "OpenAI completion-token alias"})
	}

	if req.CacheKey != "" {
		payload["prompt_cache_key"] = req.CacheKey
		disp = append(disp, FieldDisposition{Path: "cache_key", Action: DispositionPreserved, TargetPath: "prompt_cache_key"})
	}

	responseFormat, responseSchema, formatErr := effectiveResponseFormat(contracts.ProtocolOpenAIChat, req)
	if formatErr != nil {
		return nil, formatErr
	}
	if responseFormat != FormatText {
		switch responseFormat {
		case FormatJSONObject:
			payload["response_format"] = map[string]any{"type": "json_object"}
		case FormatJSONSchema:
			schema := responseSchema
			if schema == nil {
				schema = map[string]any{}
			}
			jsonSchema := map[string]any{"name": "response", "schema": schema}
			if req.StructuredOutput != nil {
				if req.StructuredOutput.Name != "" {
					jsonSchema["name"] = req.StructuredOutput.Name
				}
				if req.StructuredOutput.Description != "" {
					jsonSchema["description"] = req.StructuredOutput.Description
				}
				if strict, ok := req.StructuredOutput.Strict.Get(); ok {
					jsonSchema["strict"] = strict
				}
			}
			payload["response_format"] = map[string]any{"type": "json_schema", "json_schema": jsonSchema}
		}
		disp = append(disp, FieldDisposition{Path: "response_format", Action: DispositionAdapted})
	}

	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		payload["top_p"] = *req.TopP
	}
	if len(req.Stop) > 0 {
		payload["stop"] = append([]string(nil), req.Stop...)
	}
	if req.ParallelToolCalls != nil {
		payload["parallel_tool_calls"] = *req.ParallelToolCalls
	}
	if req.ToolChoice != nil && len(req.Tools) > 0 {
		payload["tool_choice"] = encodeToolChoice(req.ToolChoice)
		disp = append(disp, FieldDisposition{Path: "tool_choice", Action: DispositionAdapted})
	}
	if req.Metadata != nil && req.Source == contracts.ProtocolOpenAIChat {
		payload["metadata"] = req.Metadata
		disp = append(disp, FieldDisposition{Path: "metadata", Action: DispositionPreserved})
	}

	if req.Reasoning == ReasoningEnabled || req.ReasoningConfig != nil {
		if req.ReasoningConfig != nil {
			if req.ReasoningConfig.Effort != "" {
				payload["reasoning_effort"] = string(req.ReasoningConfig.Effort)
			}
			wire := map[string]any{}
			if req.ReasoningConfig.Summary != "" {
				wire["summary"] = string(req.ReasoningConfig.Summary)
			}
			if req.ReasoningConfig.MaxTokens > 0 {
				wire["max_tokens"] = req.ReasoningConfig.MaxTokens
			}
			if req.ReasoningConfig.Exclude {
				wire["exclude"] = true
			}
			if req.ReasoningConfig.Enabled {
				wire["enabled"] = true
			}
			if len(wire) > 0 {
				payload["reasoning"] = wire
			}
		} else if req.Reasoning == ReasoningEnabled {
			payload["reasoning_effort"] = string(EffortMedium)
		}
		disp = append(disp, FieldDisposition{Path: "reasoning", Action: DispositionAdapted})
	}

	if req.Stream {
		payload["stream_options"] = map[string]any{"include_usage": true}
	}

	// Passthrough: any unrecognised canonical field would have been a
	// metadata entry, already routed above. Surface any extra entries on
	// the request that the encoder did not explicitly handle as a
	// passthrough bucket so the wire payload is never lossy.
	applyPassthroughBucket(payload, req, "openai-chat")
	if err := validateWirePayload(contracts.ProtocolOpenAIChat, payload); err != nil {
		return nil, err
	}

	return &EncoderResult{Wire: payload, Dispositions: disp}, nil
}

func firstUnsupportedChatMedia(messages []NormalizedMessage) string {
	for mi, message := range messages {
		for bi, block := range message.Content {
			switch block.Type {
			case BlockAudio, BlockFile, BlockDocument, BlockPDF:
				return fmt.Sprintf("messages[%d].content[%d]", mi, bi)
			}
		}
	}
	return ""
}

// encodeChatMessages flattens normalized messages into OpenAI chat shape.
func encodeChatMessages(msgs []NormalizedMessage) []map[string]any {
	out := make([]map[string]any, 0, len(msgs))
	for _, m := range msgs {
		if m.Role == RoleTool {
			for _, b := range m.Content {
				if b.Type != BlockToolResult {
					continue
				}
				out = append(out, map[string]any{
					"role":         "tool",
					"tool_call_id": b.ToolCallID,
					"content":      b.Text,
				})
			}
			continue
		}
		entry := map[string]any{"role": string(m.Role)}
		switch m.Role {
		case RoleSystem, RoleDeveloper:
			entry["content"] = messageText(m)
		case RoleUser:
			hasImage := false
			for _, b := range m.Content {
				if b.Type == BlockImage {
					hasImage = true
					break
				}
			}
			if !hasImage {
				text := messageText(m)
				// Re-attach tool_result text in case the user message
				// also carried tool output (Anthropic-style flow).
				for _, b := range m.Content {
					if b.Type == BlockToolResult && b.Text != "" {
						if text == "" {
							text = b.Text
						} else {
							text += "\n" + b.Text
						}
					}
				}
				entry["content"] = text
			} else {
				parts := make([]map[string]any, 0, len(m.Content))
				for _, b := range m.Content {
					switch b.Type {
					case BlockText:
						parts = append(parts, map[string]any{"type": "text", "text": b.Text})
					case BlockImage:
						parts = append(parts, map[string]any{"type": "image_url", "image_url": openAIImageContent(b.Image)})
					case BlockToolResult:
						parts = append(parts, map[string]any{"type": "text", "text": b.Text})
					}
				}
				entry["content"] = parts
			}
		case RoleAssistant:
			text := messageText(m)
			calls := []map[string]any{}
			for _, b := range m.Content {
				if b.Type == BlockToolUse {
					calls = append(calls, encodeChatToolCall(b))
				}
			}
			if text != "" {
				entry["content"] = text
			} else if len(calls) > 0 {
				entry["content"] = nil
			} else {
				entry["content"] = ""
			}
			if len(calls) > 0 {
				entry["tool_calls"] = calls
			}
			if m.ReasoningContent != "" {
				entry["reasoning_content"] = m.ReasoningContent
			}
		}
		out = append(out, entry)
	}
	return out
}

func encodeChatToolCall(b ContentBlock) map[string]any {
	name := b.ToolName
	id := b.ToolCallID
	if id == "" {
		id = "call_" + name
	}
	args := b.ToolArguments
	if args == "" {
		args = b.Text
	}
	if args == "" {
		args = "{}"
	}
	return map[string]any{
		"id":   id,
		"type": "function",
		"function": map[string]any{
			"name":      name,
			"arguments": args,
		},
	}
}

// OpenAIChatRequestDecoder implements the inbound side of the OpenAI
// Chat Completions wire surface.
type OpenAIChatRequestDecoder struct{}

// NewOpenAIChatRequestDecoder constructs a chat decoder.
func NewOpenAIChatRequestDecoder() *OpenAIChatRequestDecoder { return &OpenAIChatRequestDecoder{} }

// Protocol reports the wire surface.
func (d *OpenAIChatRequestDecoder) Protocol() contracts.Protocol { return contracts.ProtocolOpenAIChat }

// Decode parses a /v1/chat/completions body into a canonical request.
func (d *OpenAIChatRequestDecoder) Decode(ctx context.Context, body []byte, stream bool) (*NormalizedRequest, *TransformError) {
	if err := ctx.Err(); err != nil {
		return nil, newTransformError(CodeContextCanceled, "decode-request", string(contracts.ProtocolOpenAIChat), "context", "transform canceled", err)
	}
	root, err := decodeBody(body)
	if err != nil {
		return nil, errDecode(contracts.ProtocolOpenAIChat, "body", err.Error())
	}

	model, _ := asString("model", root["model"])
	if model == "" {
		return nil, errDecode(contracts.ProtocolOpenAIChat, "model", "model is required")
	}
	if len(model) > MaxModelLength {
		return nil, errDecode(contracts.ProtocolOpenAIChat, "model", "model exceeds maximum length")
	}

	req := &NormalizedRequest{
		Model:      model,
		Stream:     stream,
		Source:     contracts.ProtocolOpenAIChat,
		ToolChoice: nil,
	}

	// Controls
	if v, err := asFloat("temperature", root["temperature"]); err == nil && root["temperature"] != nil {
		req.Temperature = &v
	} else if err != nil {
		return nil, errDecode(contracts.ProtocolOpenAIChat, "temperature", err.Error())
	}
	if v, err := asFloat("top_p", root["top_p"]); err == nil && root["top_p"] != nil {
		req.TopP = &v
	} else if err != nil {
		return nil, errDecode(contracts.ProtocolOpenAIChat, "top_p", err.Error())
	}
	if raw, ok := root["stop"]; ok {
		switch v := raw.(type) {
		case string:
			req.Stop = []string{v}
		case []any:
			for i, x := range v {
				s, err := asString(fmt.Sprintf("stop[%d]", i), x)
				if err != nil {
					return nil, errDecode(contracts.ProtocolOpenAIChat, "stop", err.Error())
				}
				req.Stop = append(req.Stop, s)
			}
		}
	}
	if raw, ok := root["parallel_tool_calls"]; ok {
		b, err := asBool("parallel_tool_calls", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIChat, "parallel_tool_calls", err.Error())
		}
		req.ParallelToolCalls = &b
	}
	if raw, ok := root["tool_choice"]; ok {
		tc, err := decodeToolChoice(raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIChat, "tool_choice", err.Error())
		}
		req.ToolChoice = tc
	}
	if raw, ok := root["metadata"]; ok {
		obj, err := asProto("metadata", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIChat, "metadata", err.Error())
		}
		req.Metadata = obj
	}

	// Response format
	if raw, ok := root["response_format"]; ok {
		rf, schema, err := decodeResponseFormat(raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIChat, "response_format", err.Error())
		}
		req.ResponseFormat = rf
		if schema != nil {
			req.ResponseFormatSchema = schema
		}
	}

	// max_tokens / max_completion_tokens
	if raw, ok := root["max_completion_tokens"]; ok {
		v, err := asInt("max_completion_tokens", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIChat, "max_completion_tokens", err.Error())
		}
		req.MaxOutputTokens = &v
	} else if raw, ok := root["max_tokens"]; ok {
		v, err := asInt("max_tokens", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIChat, "max_tokens", err.Error())
		}
		req.MaxOutputTokens = &v
	}

	// Cache key
	if raw, ok := root["prompt_cache_key"]; ok {
		s, _ := asString("prompt_cache_key", raw)
		if s != "" && len(s) <= 256 {
			req.CacheKey = s
		}
	}

	// Reasoning (chat allows `reasoning` object and top-level `reasoning_effort`)
	reasoning := ReasoningDefault
	var rc *ReasoningConfig
	if raw, ok := root["reasoning"]; ok && raw != nil {
		obj, err := asProto("reasoning", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIChat, "reasoning", err.Error())
		}
		if _, hasMode := obj["mode"]; hasMode {
			return nil, errDecode(contracts.ProtocolOpenAIChat, "reasoning.mode", "reasoning.mode is Responses-only")
		}
		if _, hasCtx := obj["context"]; hasCtx {
			return nil, errDecode(contracts.ProtocolOpenAIChat, "reasoning.context", "reasoning.context is Responses-only")
		}
		flag, cfg, err := parseReasoningConfig(obj, "reasoning", obj["enabled"])
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIChat, "reasoning", err.Error())
		}
		reasoning = flag
		if cfg != nil {
			rc = cfg
		}
	}
	if raw, ok := root["reasoning_effort"]; ok {
		s, _ := asString("reasoning_effort", raw)
		if e := normalizeClientEffort(s); e != "" {
			if rc == nil {
				rc = &ReasoningConfig{}
			}
			if rc.Effort == "" {
				rc.Effort = e
			}
			if reasoning == ReasoningDefault {
				reasoning = ReasoningEnabled
			}
		}
	}
	req.Reasoning = reasoning
	req.ReasoningConfig = rc

	// Messages
	images := []ImageReference{}
	reasoningSeen := false
	rawMsgs, err := asArray("messages", root["messages"])
	if err != nil {
		return nil, errDecode(contracts.ProtocolOpenAIChat, "messages", err.Error())
	}
	if len(rawMsgs) > MaxMessageCount {
		return nil, errDecode(contracts.ProtocolOpenAIChat, "messages", "too many messages")
	}
	for i, m := range rawMsgs {
		obj, err := asProto(fmt.Sprintf("messages[%d]", i), m)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIChat, fmt.Sprintf("messages[%d]", i), err.Error())
		}
		nm, err := decodeChatMessage(obj, fmt.Sprintf("messages[%d]", i), &images, &reasoningSeen)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIChat, fmt.Sprintf("messages[%d]", i), err.Error())
		}
		req.Messages = append(req.Messages, nm)
	}
	req.Images = images

	// Tools
	rawTools, err := asArray("tools", root["tools"])
	if err != nil {
		return nil, errDecode(contracts.ProtocolOpenAIChat, "tools", err.Error())
	}
	for i, t := range rawTools {
		tool, err := decodeChatTool(t, fmt.Sprintf("tools[%d]", i))
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIChat, fmt.Sprintf("tools[%d]", i), err.Error())
		}
		req.Tools = append(req.Tools, tool)
	}

	if err := req.Validate(); err != nil {
		return nil, errDecode(contracts.ProtocolOpenAIChat, "request", err.Error())
	}
	return req, nil
}

func decodeChatMessage(obj map[string]any, field string, images *[]ImageReference, reasoningSeen *bool) (NormalizedMessage, error) {
	roleStr, err := asString(field+".role", obj["role"])
	if err != nil {
		return NormalizedMessage{}, err
	}
	role, err := roleFromString(field+".role", roleStr)
	if err != nil {
		return NormalizedMessage{}, err
	}
	content, err := decodeChatContent(obj["content"], field+".content", images)
	if err != nil {
		return NormalizedMessage{}, err
	}
	nm := NormalizedMessage{Role: role, Content: content}
	if role == RoleAssistant {
		calls, err := decodeChatToolCalls(obj["tool_calls"], field+".tool_calls")
		if err != nil {
			return NormalizedMessage{}, err
		}
		if len(calls) > 0 {
			nm.Content = append(nm.Content, calls...)
		}
		if rc, ok := obj["reasoning_content"].(string); ok && rc != "" {
			nm.ReasoningContent = rc
			*reasoningSeen = true
		}
	} else if role == RoleTool {
		callID, _ := asString(field+".tool_call_id", obj["tool_call_id"])
		for i := range nm.Content {
			if nm.Content[i].Type == BlockText || nm.Content[i].Type == BlockUnknown {
				nm.Content[i].Type = BlockToolResult
				nm.Content[i].ToolCallID = callID
			}
		}
	}
	if reasoningSeen != nil && *reasoningSeen && nm.ReasoningContent == "" {
		// Allow the encoder to know the request implies thinking.
	}
	return nm, nil
}

func decodeChatContent(raw any, field string, images *[]ImageReference) ([]ContentBlock, error) {
	if raw == nil {
		return nil, nil
	}
	if s, ok := raw.(string); ok {
		if err := boundText(field, s); err != nil {
			return nil, err
		}
		return []ContentBlock{{Type: BlockText, Text: s}}, nil
	}
	list, err := asArray(field, raw)
	if err != nil {
		return nil, err
	}
	if len(list) > MaxBlocksPerMessage {
		return nil, &protoErr{field: field, reason: "too many content blocks"}
	}
	out := make([]ContentBlock, 0, len(list))
	for i, item := range list {
		obj, err := asProto(fmt.Sprintf("%s[%d]", field, i), item)
		if err != nil {
			return nil, err
		}
		t, _ := obj["type"].(string)
		switch t {
		case "text", "input_text", "output_text":
			text, err := asString(fmt.Sprintf("%s[%d].text", field, i), obj["text"])
			if err != nil {
				return nil, err
			}
			if err := boundText(fmt.Sprintf("%s[%d].text", field, i), text); err != nil {
				return nil, err
			}
			out = append(out, ContentBlock{Type: BlockText, Text: text})
		case "image_url":
			img, err := decodeImageURL(obj["image_url"], fmt.Sprintf("%s[%d].image_url", field, i), images)
			if err != nil {
				return nil, err
			}
			out = append(out, ContentBlock{Type: BlockImage, Image: &img})
		default:
			if t == "" {
				return nil, &protoErr{field: fmt.Sprintf("%s[%d].type", field, i), reason: "missing content block type"}
			}
			out = append(out, ContentBlock{Type: BlockNative, NativeType: t, NativePayload: jsonclone.CloneMap(obj), Raw: jsonclone.CloneMap(obj)})
		}
	}
	return out, nil
}

func decodeChatToolCalls(raw any, field string) ([]ContentBlock, error) {
	if raw == nil {
		return nil, nil
	}
	list, err := asArray(field, raw)
	if err != nil {
		return nil, err
	}
	if len(list) > MaxToolCallsPerMessage {
		return nil, &protoErr{field: field, reason: "too many tool_calls"}
	}
	out := make([]ContentBlock, 0, len(list))
	for i, item := range list {
		obj, err := asProto(fmt.Sprintf("%s[%d]", field, i), item)
		if err != nil {
			return nil, err
		}
		if t, has := obj["type"]; has && t != "function" {
			return nil, &protoErr{field: fmt.Sprintf("%s[%d].type", field, i), reason: fmt.Sprintf("unsupported tool call type %v", t)}
		}
		fn, err := asProto(fmt.Sprintf("%s[%d].function", field, i), obj["function"])
		if err != nil {
			return nil, err
		}
		name, err := asString(fmt.Sprintf("%s[%d].function.name", field, i), fn["name"])
		if err != nil {
			return nil, err
		}
		if name == "" {
			return nil, &protoErr{field: fmt.Sprintf("%s[%d].function.name", field, i), reason: "tool call name must not be empty"}
		}
		if len(name) > MaxToolNameLength {
			return nil, &protoErr{field: fmt.Sprintf("%s[%d].function.name", field, i), reason: "tool name too long"}
		}
		id, _ := asString(fmt.Sprintf("%s[%d].id", field, i), obj["id"])
		if len(id) > 128 {
			return nil, &protoErr{field: fmt.Sprintf("%s[%d].id", field, i), reason: "tool call id too long"}
		}
		args, err := StringifyToolArguments(fn["arguments"])
		if err != nil {
			return nil, &protoErr{field: fmt.Sprintf("%s[%d].function.arguments", field, i), reason: err.Error()}
		}
		out = append(out, ContentBlock{
			Type:          BlockToolUse,
			ToolName:      name,
			ToolCallID:    id,
			ToolArguments: RepairToolCallArguments(args),
		})
	}
	return out, nil
}

func decodeChatTool(raw any, field string) (Tool, error) {
	obj, err := asProto(field, raw)
	if err != nil {
		return Tool{}, err
	}
	t, _ := obj["type"].(string)
	if t != "" && t != "function" {
		return Tool{}, &protoErr{field: field + ".type", reason: fmt.Sprintf("unsupported tool type %q", t)}
	}
	fn, err := asProto(field+".function", obj["function"])
	if err != nil {
		return Tool{}, err
	}
	name, err := asString(field+".function.name", fn["name"])
	if err != nil {
		return Tool{}, err
	}
	if name == "" {
		return Tool{}, &protoErr{field: field + ".function.name", reason: "tool name must not be empty"}
	}
	desc, _ := asString(field+".function.description", fn["description"])
	var schema map[string]any
	if raw, ok := fn["parameters"]; ok {
		schema, _ = asProto(field+".function.parameters", raw)
	}
	return Tool{
		Name:        name,
		Description: desc,
		InputSchema: schema,
	}, nil
}
