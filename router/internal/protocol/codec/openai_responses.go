package codec

import (
	"context"
	"fmt"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// OpenAIResponsesCodec implements request encoding for the OpenAI
// Responses wire surface.
type OpenAIResponsesCodec struct{}

// NewOpenAIResponsesCodec constructs a responses encoder.
func NewOpenAIResponsesCodec() *OpenAIResponsesCodec { return &OpenAIResponsesCodec{} }

// Protocol reports the wire surface.
func (c *OpenAIResponsesCodec) Protocol() contracts.Protocol { return contracts.ProtocolOpenAIResponse }

// Encode projects a canonical request onto /v1/responses.
//
// Stream handling: the encoder respects req.Stream. When true the wire
// payload carries `stream: true`; false is emitted verbatim so the flag
// can never be silently flipped. Reasoning summaries default to
// `concise` when no summary is set, matching the open-sse default that
// keeps terminal clients from receiving verbose reasoning.
func (c *OpenAIResponsesCodec) Encode(ctx context.Context, req *NormalizedRequest) (*EncoderResult, *TransformError) {
	if err := ctx.Err(); err != nil {
		return nil, newTransformError(CodeContextCanceled, "encode-request", string(contracts.ProtocolOpenAIResponse), "context", "transform canceled", err)
	}
	if req == nil {
		return nil, errEncode(contracts.ProtocolOpenAIResponse, "request", "request must not be nil")
	}
	if err := req.Validate(); err != nil {
		return nil, errEncode(contracts.ProtocolOpenAIResponse, "request", err.Error())
	}
	input := encodeResponsesInput(req.Messages, req.TrailingReasoningItems)
	if req.Operation.Kind == OperationCompactV2 && req.Operation.Compaction != nil {
		input = encodeCompactionResponsesInput(req.Operation.Compaction)
	}
	if req.Operation.Kind == OperationCompactV1 {
		return nil, errEncode(contracts.ProtocolOpenAIResponse, "operation", "V1 compaction requires a dedicated compact endpoint or approved bridge")
	}
	payload := map[string]any{
		"model":  req.Model,
		"stream": req.Stream,
		"input":  input,
	}
	var disp []FieldDisposition

	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			if t.NativeType == "mcp_toolset" || t.NativeType == "web_fetch" {
				return nil, errEncode(contracts.ProtocolOpenAIResponse, "tools", fmt.Sprintf("native tool %q requires anthropic surface", t.NativeType))
			}
			if t.NativeType != "" {
				native := cloneMap(t.NativeOptions)
				if native == nil {
					native = map[string]any{}
				}
				native["type"] = t.NativeType
				if t.Name != "" {
					native["name"] = t.Name
				}
				if t.Description != "" {
					native["description"] = t.Description
				}
				tools = append(tools, native)
				continue
			}
			tools = append(tools, map[string]any{
				"type": "function", "name": t.Name,
				"description": nilIfEmpty(t.Description), "parameters": t.InputSchema,
			})
		}
		payload["tools"] = tools
		disp = append(disp, FieldDisposition{Path: "tools", Action: DispositionAdapted, Reason: "responses tools"})
	}

	if req.MaxOutputTokens != nil {
		payload["max_output_tokens"] = *req.MaxOutputTokens
	}
	if req.CacheKey != "" {
		payload["prompt_cache_key"] = req.CacheKey
	}
	if req.PreviousResponseID != "" {
		payload["previous_response_id"] = req.PreviousResponseID
	}
	if req.ConversationID != "" {
		payload["conversation"] = req.ConversationID
	}

	responseFormat, responseSchema, formatErr := effectiveResponseFormat(contracts.ProtocolOpenAIResponse, req)
	if formatErr != nil {
		return nil, formatErr
	}
	if responseFormat != FormatText {
		switch responseFormat {
		case FormatJSONObject:
			payload["text"] = map[string]any{"format": map[string]any{"type": "json_object"}}
		case FormatJSONSchema:
			schema := responseSchema
			if schema == nil {
				schema = map[string]any{}
			}
			format := map[string]any{"type": "json_schema", "schema": schema}
			if req.StructuredOutput != nil {
				if req.StructuredOutput.Name != "" {
					format["name"] = req.StructuredOutput.Name
				}
				if req.StructuredOutput.Description != "" {
					format["description"] = req.StructuredOutput.Description
				}
				if strict, ok := req.StructuredOutput.Strict.Get(); ok {
					format["strict"] = strict
				}
			}
			payload["text"] = map[string]any{"format": format}
		}
		disp = append(disp, FieldDisposition{Path: "response_format", Action: DispositionAdapted, TargetPath: "text.format"})
	}

	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		payload["top_p"] = *req.TopP
	}
	if req.ParallelToolCalls != nil {
		payload["parallel_tool_calls"] = *req.ParallelToolCalls
	}
	if req.ToolChoice != nil {
		payload["tool_choice"] = encodeToolChoice(req.ToolChoice)
	}
	if req.Metadata != nil && req.Source == contracts.ProtocolOpenAIResponse {
		payload["metadata"] = req.Metadata
		disp = append(disp, FieldDisposition{Path: "metadata", Action: DispositionPreserved})
	}

	if req.Reasoning == ReasoningEnabled || req.ReasoningConfig != nil {
		payload["reasoning"] = buildResponsesReasoningWire(req.Reasoning, req.ReasoningConfig)
		disp = append(disp, FieldDisposition{Path: "reasoning", Action: DispositionAdapted})
	}

	if len(req.Include) > 0 {
		payload["include"] = append([]string(nil), req.Include...)
	}
	if req.ContextManagement != nil {
		value, err := req.ContextManagement.WireValue()
		if err != nil {
			return nil, errEncode(contracts.ProtocolOpenAIResponse, "context_management", err.Error())
		}
		payload["context_management"] = value
		disp = append(disp, FieldDisposition{Path: "context_management", Action: DispositionPreserved})
	}

	applyPassthroughBucket(payload, req, "openai-responses")
	if err := validateWirePayload(contracts.ProtocolOpenAIResponse, payload); err != nil {
		return nil, err
	}
	return &EncoderResult{Wire: payload, Dispositions: disp}, nil
}

// buildResponsesReasoningWire maps the canonical ReasoningConfig onto the
// Responses wire object, respecting the "concise" default summary.
func buildResponsesReasoningWire(flag ReasoningFlag, cfg *ReasoningConfig) map[string]any {
	if cfg == nil {
		if flag == ReasoningEnabled {
			return map[string]any{"effort": string(EffortMedium), "summary": "concise"}
		}
		return map[string]any{"enabled": false}
	}
	wire := map[string]any{}
	if cfg.Effort != "" {
		wire["effort"] = string(cfg.Effort)
	}
	switch {
	case cfg.Summary != "":
		wire["summary"] = string(cfg.Summary)
	case cfg.Enabled:
		wire["summary"] = "concise"
	}
	if cfg.MaxTokens > 0 {
		wire["max_tokens"] = cfg.MaxTokens
	}
	if cfg.Exclude {
		wire["exclude"] = true
	}
	if cfg.Enabled {
		wire["enabled"] = true
	}
	if cfg.Mode != "" {
		wire["mode"] = string(cfg.Mode)
	}
	if cfg.Context != "" {
		wire["context"] = string(cfg.Context)
	}
	if len(wire) == 0 {
		return map[string]any{"enabled": false}
	}
	return wire
}

// encodeResponsesInput flattens normalized messages into the Responses
// item stream. Reasoning items are emitted before the message they were
// attached to (semantically, they belong to the prior assistant turn).
func encodeResponsesInput(msgs []NormalizedMessage, trailing []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(msgs))
	for _, m := range msgs {
		items := append([]map[string]any{}, m.ReasoningItemsBefore...)
		switch m.Role {
		case RoleSystem, RoleDeveloper:
			items = append(items, map[string]any{"type": "message", "role": string(m.Role), "content": messageText(m)})
		case RoleUser:
			hasImage := false
			hasRichMedia := false
			for _, b := range m.Content {
				if b.Type == BlockImage {
					hasImage = true
					break
				}
				if b.Type == BlockAudio || b.Type == BlockFile || b.Type == BlockDocument || b.Type == BlockPDF || b.Type == BlockNative || b.Type == BlockUnknown {
					hasRichMedia = true
				}
			}
			if !hasImage && !hasRichMedia {
				items = append(items, map[string]any{"type": "message", "role": "user", "content": messageText(m)})
			} else {
				parts := make([]map[string]any, 0, len(m.Content))
				for _, b := range m.Content {
					switch b.Type {
					case BlockText:
						parts = append(parts, map[string]any{"type": "input_text", "text": b.Text})
					case BlockImage:
						parts = append(parts, openAIInputImage(b.Image))
					case BlockAudio:
						if b.Audio != nil {
							parts = append(parts, map[string]any{"type": "input_audio", "audio_data": b.Audio.Value, "format": audioFormat(b.Audio.MIMEType)})
						}
					case BlockFile, BlockDocument, BlockPDF:
						if media := contentMediaReference(b); media != nil {
							parts = append(parts, encodeResponsesFileReference(media))
						}
					case BlockNative, BlockUnknown:
						if b.Raw != nil {
							parts = append(parts, cloneMap(b.Raw))
						}
					}
				}
				items = append(items, map[string]any{"type": "message", "role": "user", "content": parts})
			}
		case RoleAssistant:
			for _, b := range m.Content {
				if b.Type == BlockCompaction && b.Raw != nil {
					items = append(items, cloneMap(b.Raw))
				} else if b.Type == BlockCompaction && b.Compaction != nil {
					item := map[string]any{"type": string(b.Compaction.Kind)}
					if b.Compaction.EncryptedContent != "" {
						item["encrypted_content"] = b.Compaction.EncryptedContent
					}
					if b.Compaction.Summary != "" {
						item["summary"] = b.Compaction.Summary
					}
					if b.Compaction.Signature != "" {
						item["signature"] = b.Compaction.Signature
					}
					if b.ID != "" {
						item["id"] = b.ID
					}
					items = append(items, item)
				} else if b.Type == BlockReasoning {
					items = append(items, encodeResponsesReasoningItem(b))
				} else if (b.Type == BlockNative || b.Type == BlockUnknown) && b.Raw != nil {
					items = append(items, cloneMap(b.Raw))
				}
			}
			text := messageText(m)
			calls := []ContentBlock{}
			for _, b := range m.Content {
				if b.Type == BlockToolUse {
					calls = append(calls, b)
				}
			}
			msg := map[string]any{"type": "message", "role": "assistant", "content": []map[string]any{{"type": "output_text", "text": text}}}
			if m.Phase != "" {
				msg["phase"] = m.Phase
			}
			items = append(items, msg)
			for _, b := range calls {
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
				items = append(items, map[string]any{
					"type":      "function_call",
					"call_id":   id,
					"name":      name,
					"arguments": args,
				})
			}
		case RoleTool:
			for _, b := range m.Content {
				if b.Type != BlockToolResult {
					continue
				}
				items = append(items, map[string]any{
					"type":    "function_call_output",
					"call_id": b.ToolCallID,
					"output":  b.Text,
				})
			}
		}
		out = append(out, items...)
	}
	for _, item := range trailing {
		out = append(out, cloneMap(item))
	}
	return out
}

func encodeCompactionResponsesInput(request *CompactionRequest) []map[string]any {
	if request == nil {
		return nil
	}
	input := make([]map[string]any, 0, len(request.Input)+1)
	for _, block := range request.Input {
		switch block.Type {
		case BlockCompactionTrigger:
			continue
		case BlockText:
			input = append(input, map[string]any{"type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": block.Text}}})
		case BlockImage:
			input = append(input, map[string]any{"type": "message", "role": "user", "content": []map[string]any{openAIInputImage(block.Image)}})
		case BlockAudio:
			if block.Audio != nil {
				input = append(input, map[string]any{"type": "message", "role": "user", "content": []map[string]any{{"type": "input_audio", "audio_data": block.Audio.Value, "format": audioFormat(block.Audio.MIMEType)}}})
			}
		case BlockFile, BlockDocument, BlockPDF:
			if media := contentMediaReference(block); media != nil {
				input = append(input, map[string]any{"type": "message", "role": "user", "content": []map[string]any{encodeResponsesFileReference(media)}})
			}
		case BlockReasoning:
			input = append(input, encodeResponsesReasoningItem(block))
		case BlockToolUse:
			input = append(input, map[string]any{"type": "function_call", "call_id": block.ToolCallID, "name": block.ToolName, "arguments": block.ToolArguments})
		case BlockToolResult:
			input = append(input, map[string]any{"type": "function_call_output", "call_id": block.ToolCallID, "output": block.Text})
		default:
			if block.Raw != nil {
				input = append(input, cloneMap(block.Raw))
			}
		}
	}
	input = append(input, map[string]any{"type": "compaction_trigger"})
	return input
}

func contentMediaReference(block ContentBlock) *MediaReference {
	if block.File != nil {
		return block.File
	}
	if block.Document != nil {
		return block.Document
	}
	return block.Media
}

func audioFormat(mime string) string {
	switch mime {
	case "audio/wav":
		return "wav"
	case "audio/mpeg":
		return "mp3"
	case "audio/ogg":
		return "ogg"
	default:
		return mime
	}
}

func encodeResponsesFileReference(media *MediaReference) map[string]any {
	payload := map[string]any{"type": "input_file", "filename": nilIfEmpty(media.Filename), "mime_type": nilIfEmpty(media.MIMEType)}
	switch media.Reference {
	case ReferenceProviderFileID:
		payload["file_id"] = media.Value
	case ReferenceProviderFileURL:
		payload["file_url"] = media.Value
	case ReferenceInlineData:
		payload["file_data"] = media.Value
	case ReferenceURL:
		payload["file_url"] = media.Value
	}
	return payload
}

func encodeResponsesReasoningItem(b ContentBlock) map[string]any {
	item := map[string]any{"type": "reasoning"}
	if b.Raw != nil {
		if id, ok := b.Raw["id"].(string); ok {
			item["id"] = id
		}
		if enc, ok := b.Raw["encrypted_content"].(string); ok {
			item["encrypted_content"] = enc
		}
		if sum, ok := b.Raw["summary"].([]any); ok {
			item["summary"] = sum
		}
	}
	if _, ok := item["encrypted_content"].(string); !ok && b.ReasoningEncryptedContent != "" {
		item["encrypted_content"] = b.ReasoningEncryptedContent
	}
	if _, ok := item["summary"]; !ok {
		if len(b.ReasoningSummary) > 0 {
			item["summary"] = b.ReasoningSummary
		} else if b.ReasoningText != "" {
			item["summary"] = []map[string]any{{"type": "summary_text", "text": b.ReasoningText}}
		}
	}
	return item
}

// OpenAIResponsesRequestDecoder implements the inbound side.
type OpenAIResponsesRequestDecoder struct{}

// NewOpenAIResponsesRequestDecoder constructs the decoder.
func NewOpenAIResponsesRequestDecoder() *OpenAIResponsesRequestDecoder {
	return &OpenAIResponsesRequestDecoder{}
}

// Protocol reports the wire surface.
func (d *OpenAIResponsesRequestDecoder) Protocol() contracts.Protocol {
	return contracts.ProtocolOpenAIResponse
}

// Decode parses a /v1/responses body into a canonical request.
func (d *OpenAIResponsesRequestDecoder) Decode(ctx context.Context, body []byte, stream bool) (*NormalizedRequest, *TransformError) {
	if err := ctx.Err(); err != nil {
		return nil, newTransformError(CodeContextCanceled, "decode-request", string(contracts.ProtocolOpenAIResponse), "context", "transform canceled", err)
	}
	root, err := decodeBody(body)
	if err != nil {
		return nil, errDecode(contracts.ProtocolOpenAIResponse, "body", err.Error())
	}
	model, _ := asString("model", root["model"])
	if model == "" {
		return nil, errDecode(contracts.ProtocolOpenAIResponse, "model", "model is required")
	}
	req := &NormalizedRequest{
		Model:  model,
		Stream: stream,
		Source: contracts.ProtocolOpenAIResponse,
	}

	if raw, ok := root["text"]; ok {
		rf, schema, err := decodeResponsesText(raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "text", err.Error())
		}
		req.ResponseFormat = rf
		if schema != nil {
			req.ResponseFormatSchema = schema
		}
	}

	if raw, ok := root["reasoning"]; ok && raw != nil {
		obj, err := asProto("reasoning", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "reasoning", err.Error())
		}
		flag, cfg, err := parseReasoningConfig(obj, "reasoning", obj["enabled"])
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "reasoning", err.Error())
		}
		req.Reasoning = flag
		req.ReasoningConfig = cfg
	}
	if raw, ok := root["reasoning_effort"]; ok {
		s, _ := asString("reasoning_effort", raw)
		if e := normalizeClientEffort(s); e != "" {
			if req.ReasoningConfig == nil {
				req.ReasoningConfig = &ReasoningConfig{}
			}
			if req.ReasoningConfig.Effort == "" {
				req.ReasoningConfig.Effort = e
			}
			if req.Reasoning == ReasoningDefault {
				req.Reasoning = ReasoningEnabled
			}
		}
	}

	if raw, ok := root["max_output_tokens"]; ok {
		v, err := asInt("max_output_tokens", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "max_output_tokens", err.Error())
		}
		req.MaxOutputTokens = &v
	}

	if raw, ok := root["temperature"]; ok {
		v, err := asFloat("temperature", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "temperature", err.Error())
		}
		req.Temperature = &v
	}
	if raw, ok := root["top_p"]; ok {
		v, err := asFloat("top_p", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "top_p", err.Error())
		}
		req.TopP = &v
	}
	if raw, ok := root["parallel_tool_calls"]; ok {
		b, err := asBool("parallel_tool_calls", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "parallel_tool_calls", err.Error())
		}
		req.ParallelToolCalls = &b
	}
	if raw, ok := root["tool_choice"]; ok {
		tc, err := decodeToolChoice(raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "tool_choice", err.Error())
		}
		req.ToolChoice = tc
	}
	if raw, ok := root["metadata"]; ok {
		obj, err := asProto("metadata", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "metadata", err.Error())
		}
		req.Metadata = obj
	}
	if raw, ok := root["context_management"]; ok {
		contextManagement, err := DecodeContextManagement(raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "context_management", err.Error())
		}
		req.ContextManagement = contextManagement
	}
	if raw, ok := root["include"]; ok {
		list, err := asArray("include", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "include", err.Error())
		}
		for i, x := range list {
			s, ok := x.(string)
			if !ok || s == "" {
				return nil, errDecode(contracts.ProtocolOpenAIResponse, fmt.Sprintf("include[%d]", i), "expected non-empty string")
			}
			if len(s) > 128 {
				return nil, errDecode(contracts.ProtocolOpenAIResponse, fmt.Sprintf("include[%d]", i), "exceeds maximum length")
			}
			req.Include = append(req.Include, s)
		}
	}
	if raw, ok := root["prompt_cache_key"]; ok {
		s, _ := asString("prompt_cache_key", raw)
		if s != "" && len(s) <= 256 {
			req.CacheKey = s
		}
	}
	if raw, ok := root["previous_response_id"]; ok {
		value, err := asString("previous_response_id", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "previous_response_id", err.Error())
		}
		req.PreviousResponseID = value
	}
	if raw, ok := root["conversation"]; ok {
		value, err := asString("conversation", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "conversation", err.Error())
		}
		req.ConversationID = value
	}
	if raw, ok := root["instructions"]; ok {
		if s, ok := raw.(string); ok {
			if err := boundText("instructions", s); err != nil {
				return nil, errDecode(contracts.ProtocolOpenAIResponse, "instructions", err.Error())
			}
			req.Messages = append(req.Messages, NormalizedMessage{
				Role:    RoleSystem,
				Content: []ContentBlock{{Type: BlockText, Text: s}},
			})
		} else {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "instructions", "expected a string")
		}
	}

	images := []ImageReference{}
	reasoningSeen := false
	if raw, ok := root["input"]; ok {
		additional, err := decodeResponsesAdditionalTools(raw, "input")
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "input", err.Error())
		}
		req.Tools = append(req.Tools, additional...)
		msgs, trailing, err := decodeResponsesInput(raw, "input", &images, &reasoningSeen)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "input", err.Error())
		}
		req.Messages = append(req.Messages, msgs...)
		req.TrailingReasoningItems = trailing
		if hasResponsesCompactionTrigger(raw) {
			input := make([]CompactionItem, 0, len(req.Messages))
			for _, message := range req.Messages {
				input = append(input, message.Content...)
			}
			compaction, compactionErr := NewCompactionRequest(CompactionRequestInput{
				Version:      CompactionV2,
				Model:        req.Model,
				Input:        input,
				Instructions: firstSystemInstruction(req.Messages),
			})
			if compactionErr != nil {
				return nil, errDecode(contracts.ProtocolOpenAIResponse, "input", compactionErr.Error())
			}
			req.Operation = Operation{Kind: OperationCompactV2, Compaction: compaction}
		}
	}
	req.Images = images
	if req.Reasoning == "" {
		req.Reasoning = ReasoningDefault
	}
	if reasoningSeen && req.Reasoning == ReasoningDefault {
		req.Reasoning = ReasoningEnabled
	}

	if raw, ok := root["tools"]; ok {
		list, err := asArray("tools", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolOpenAIResponse, "tools", err.Error())
		}
		for i, t := range list {
			tool, err := decodeResponsesTool(t, fmt.Sprintf("tools[%d]", i))
			if err != nil {
				return nil, errDecode(contracts.ProtocolOpenAIResponse, fmt.Sprintf("tools[%d]", i), err.Error())
			}
			req.Tools = append(req.Tools, tool)
		}
	}

	if err := req.Validate(); err != nil {
		return nil, errDecode(contracts.ProtocolOpenAIResponse, "request", err.Error())
	}
	return req, nil
}

// decodeResponsesText handles the Responses-specific `text.format`
// wrapper. It is functionally similar to decodeResponseFormat but
// addresses a different path prefix.
func decodeResponsesText(raw any) (ResponseFormat, map[string]any, error) {
	obj, err := asProto("text", raw)
	if err != nil {
		return "", nil, err
	}
	format, err := asProto("text.format", obj["format"])
	if err != nil {
		// `text` without a `format` wrapper is acceptable: it implies text.
		return FormatText, nil, nil
	}
	t, _ := format["type"].(string)
	switch t {
	case "text", "":
		return FormatText, nil, nil
	case "json_object":
		return FormatJSONObject, nil, nil
	case "json_schema":
		schema, _ := asProto("text.format.schema", format["schema"])
		if schema == nil {
			schema, _ = asProto("text.format.json_schema", format["json_schema"])
		}
		if err := boundJSON("text.format.json_schema", schema, MaxTextBlockLength); err != nil {
			return "", nil, err
		}
		return FormatJSONSchema, schema, nil
	default:
		return "", nil, &protoErr{field: "text.format.type", reason: "unsupported format"}
	}
}

// decodeResponsesInput accepts either a string or an item array.
func decodeResponsesInput(raw any, field string, images *[]ImageReference, reasoningSeen *bool) ([]NormalizedMessage, []map[string]any, error) {
	if raw == nil {
		return nil, nil, nil
	}
	if s, ok := raw.(string); ok {
		if err := boundText(field, s); err != nil {
			return nil, nil, err
		}
		return []NormalizedMessage{{Role: RoleUser, Content: []ContentBlock{{Type: BlockText, Text: s}}}}, nil, nil
	}
	list, err := asArray(field, raw)
	if err != nil {
		return nil, nil, err
	}
	if len(list) > MaxMessageCount {
		return nil, nil, &protoErr{field: field, reason: "too many items"}
	}
	msgs := []NormalizedMessage{}
	pending := []map[string]any{}
	for i, item := range list {
		itemField := fmt.Sprintf("%s[%d]", field, i)
		obj, err := asProto(itemField, item)
		if err != nil {
			return nil, nil, err
		}
		t, _ := obj["type"].(string)
		// Older Responses clients may omit the item discriminator on ordinary
		// role/content messages. Preserve that compatible shape while keeping
		// explicit unknown item types strict.
		if t == "" {
			if _, hasRole := obj["role"]; hasRole {
				if _, hasContent := obj["content"]; hasContent {
					t = "message"
				}
			}
		}
		switch t {
		case "message":
			roleStr, _ := asString(itemField+".role", obj["role"])
			role, err := roleFromString(itemField+".role", roleStr)
			if err != nil {
				return nil, nil, err
			}
			if role == RoleTool {
				return nil, nil, &protoErr{field: itemField + ".role", reason: "messages may not use tool role"}
			}
			content, err := decodeResponsesContent(obj["content"], itemField+".content", images, reasoningSeen)
			if err != nil {
				return nil, nil, err
			}
			nm := NormalizedMessage{Role: role, Content: content}
			if role == RoleAssistant {
				if phase, ok := obj["phase"].(string); ok {
					nm.Phase = phase
				}
			}
			if len(pending) > 0 {
				nm.ReasoningItemsBefore = cloneMapList(pending)
				pending = pending[:0]
			}
			msgs = append(msgs, nm)
		case "function_call":
			nm, err := decodeResponsesFunctionCallItem(obj, itemField)
			if err != nil {
				return nil, nil, err
			}
			if len(pending) > 0 {
				nm.ReasoningItemsBefore = cloneMapList(pending)
				pending = pending[:0]
			}
			msgs = append(msgs, nm)
		case "function_call_output":
			nm, err := decodeResponsesFunctionCallOutputItem(obj, itemField)
			if err != nil {
				return nil, nil, err
			}
			if len(pending) > 0 {
				nm.ReasoningItemsBefore = cloneMapList(pending)
				pending = pending[:0]
			}
			msgs = append(msgs, nm)
		case "reasoning":
			item, err := decodeResponsesReasoningItemObj(obj, itemField)
			if err != nil {
				return nil, nil, err
			}
			pending = append(pending, item)
			if reasoningSeen != nil {
				*reasoningSeen = true
			}
		case "compaction":
			pending = append(pending, cloneMap(obj))
		case "compaction_trigger":
			trigger := ContentBlock{Type: BlockCompactionTrigger, ID: stringOf(obj["id"]), Raw: cloneMap(obj), Compaction: &CompactionContent{Version: CompactionV2, Kind: CompactionItemTrigger}}
			msgs = append(msgs, NormalizedMessage{Role: RoleAssistant, Content: []ContentBlock{trigger}})
		case "additional_tools":
			// Additional tools are declarations carried in the input item;
			// decodeResponsesAdditionalTools projects them into req.Tools.
			continue
		default:
			if t == "" {
				return nil, nil, &protoErr{field: itemField + ".type", reason: "missing item type"}
			}
			return nil, nil, &protoErr{field: itemField + ".type", reason: fmt.Sprintf("unsupported item type %q", t)}
		}
	}
	return msgs, pending, nil
}

func hasResponsesCompactionTrigger(raw any) bool {
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return false
	}
	for _, item := range list {
		obj, ok := item.(map[string]any)
		if ok && stringOf(obj["type"]) == "compaction_trigger" {
			return true
		}
	}
	return false
}

func firstSystemInstruction(messages []NormalizedMessage) string {
	for _, message := range messages {
		if message.Role == RoleSystem {
			return messageText(message)
		}
	}
	return ""
}

func decodeResponsesContent(raw any, field string, images *[]ImageReference, reasoningSeen *bool) ([]ContentBlock, error) {
	if raw == nil {
		return nil, nil
	}
	if text, ok := raw.(string); ok {
		if err := boundText(field, text); err != nil {
			return nil, err
		}
		return []ContentBlock{{Type: BlockText, Text: text}}, nil
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
		blockField := fmt.Sprintf("%s[%d]", field, i)
		obj, err := asProto(blockField, item)
		if err != nil {
			return nil, err
		}
		t, _ := obj["type"].(string)
		switch t {
		case "input_text", "output_text":
			text, err := asString(blockField+".text", obj["text"])
			if err != nil {
				return nil, err
			}
			if err := boundText(blockField+".text", text); err != nil {
				return nil, err
			}
			out = append(out, ContentBlock{Type: BlockText, Text: text})
		case "input_image":
			imageRaw := obj["image_url"]
			if detail, ok := obj["detail"].(string); ok {
				if imageURL, ok := imageRaw.(string); ok {
					imageRaw = map[string]any{"url": imageURL, "detail": detail}
				}
			}
			img, err := decodeImageURL(imageRaw, blockField+".image_url", images)
			if err != nil {
				return nil, err
			}
			out = append(out, ContentBlock{Type: BlockImage, Image: &img})
		case "input_audio":
			data, err := asString(blockField+".audio_data", obj["audio_data"])
			if err != nil {
				return nil, err
			}
			format, _ := asString(blockField+".format", obj["format"])
			media, mediaErr := NewAudioReference(ReferenceInlineData, data, MediaReferenceOptions{MIMEType: audioMIMEType(format)})
			if mediaErr != nil {
				return nil, mediaErr
			}
			out = append(out, ContentBlock{Type: BlockAudio, Audio: &media})
		case "input_file":
			media, mediaErr := decodeResponsesFileReference(obj, blockField)
			if mediaErr != nil {
				return nil, mediaErr
			}
			blockType := BlockFile
			if media.MIMEType == "application/pdf" {
				blockType = BlockPDF
			}
			out = append(out, ContentBlock{Type: blockType, File: &media})
		case "function_call":
			b, err := decodeResponsesFunctionCallBlock(obj, blockField)
			if err != nil {
				return nil, err
			}
			out = append(out, b)
		case "function_call_output":
			b, err := decodeResponsesFunctionCallOutputBlock(obj, blockField)
			if err != nil {
				return nil, err
			}
			out = append(out, b)
		case "reasoning":
			normalized, err := decodeResponsesReasoningItemObj(obj, blockField)
			if err != nil {
				return nil, err
			}
			if reasoningSeen != nil {
				*reasoningSeen = true
			}
			summary := []map[string]any{}
			if v, ok := normalized["summary"].([]any); ok {
				for _, s := range v {
					if m, ok := s.(map[string]any); ok {
						summary = append(summary, m)
					}
				}
			}
			out = append(out, ContentBlock{
				Type:                      BlockReasoning,
				NativeType:                "reasoning",
				NativePayload:             normalized,
				ReasoningEncryptedContent: stringOf(normalized["encrypted_content"]),
				ReasoningSummary:          summary,
				Raw:                       normalized,
			})
		case "refusal":
			refusal, err := asString(blockField+".refusal", obj["refusal"])
			if err != nil {
				return nil, err
			}
			out = append(out, ContentBlock{Type: BlockRefusal, Refusal: &RefusalContent{Text: refusal}})
		default:
			if t == "" {
				return nil, &protoErr{field: blockField + ".type", reason: "missing block type"}
			}
			text, _ := obj["text"].(string)
			out = append(out, ContentBlock{Type: BlockUnknown, Text: text, Raw: cloneMap(obj)})
		}
	}
	return out, nil
}

func audioMIMEType(format string) string {
	switch format {
	case "wav":
		return "audio/wav"
	case "mp3":
		return "audio/mpeg"
	case "ogg":
		return "audio/ogg"
	default:
		return format
	}
}

func decodeResponsesFileReference(obj map[string]any, field string) (FileReference, error) {
	filename, _ := asString(field+".filename", obj["filename"])
	mime, _ := asString(field+".mime_type", obj["mime_type"])
	if value, ok := obj["file_id"]; ok {
		id, err := asString(field+".file_id", value)
		if err != nil {
			return FileReference{}, err
		}
		file, terr := NewFileReference(ReferenceProviderFileID, id, MediaReferenceOptions{MIMEType: mime, Filename: filename})
		if terr != nil {
			return FileReference{}, terr
		}
		return file, nil
	}
	if value, ok := obj["file_url"]; ok {
		url, err := asString(field+".file_url", value)
		if err != nil {
			return FileReference{}, err
		}
		file, terr := NewFileReference(ReferenceProviderFileURL, url, MediaReferenceOptions{MIMEType: mime, Filename: filename})
		if terr != nil {
			return FileReference{}, terr
		}
		return file, nil
	}
	if value, ok := obj["file_data"]; ok {
		data, err := asString(field+".file_data", value)
		if err != nil {
			return FileReference{}, err
		}
		file, terr := NewFileReference(ReferenceInlineData, data, MediaReferenceOptions{MIMEType: mime, Filename: filename})
		if terr != nil {
			return FileReference{}, terr
		}
		return file, nil
	}
	return FileReference{}, &protoErr{field: field, reason: "one file_id, file_url, or file_data is required"}
}

func decodeResponsesFunctionCallItem(obj map[string]any, field string) (NormalizedMessage, error) {
	block, err := decodeResponsesFunctionCallBlock(obj, field)
	if err != nil {
		return NormalizedMessage{}, err
	}
	return NormalizedMessage{Role: RoleAssistant, Content: []ContentBlock{block}}, nil
}

func decodeResponsesFunctionCallOutputItem(obj map[string]any, field string) (NormalizedMessage, error) {
	block, err := decodeResponsesFunctionCallOutputBlock(obj, field)
	if err != nil {
		return NormalizedMessage{}, err
	}
	return NormalizedMessage{Role: RoleTool, Content: []ContentBlock{block}}, nil
}

func decodeResponsesFunctionCallBlock(obj map[string]any, field string) (ContentBlock, error) {
	callID, _ := asString(field+".call_id", obj["call_id"])
	if callID == "" {
		return ContentBlock{}, &protoErr{field: field + ".call_id", reason: "call_id must not be empty"}
	}
	name, err := asString(field+".name", obj["name"])
	if err != nil {
		return ContentBlock{}, err
	}
	if name == "" {
		return ContentBlock{}, &protoErr{field: field + ".name", reason: "function call name must not be empty"}
	}
	if len(name) > MaxToolNameLength {
		return ContentBlock{}, &protoErr{field: field + ".name", reason: "tool name too long"}
	}
	args, err := StringifyToolArguments(obj["arguments"])
	if err != nil {
		return ContentBlock{}, &protoErr{field: field + ".arguments", reason: err.Error()}
	}
	return ContentBlock{
		Type:          BlockToolUse,
		ToolName:      name,
		ToolCallID:    callID,
		ToolArguments: RepairToolCallArguments(args),
	}, nil
}

func decodeResponsesFunctionCallOutputBlock(obj map[string]any, field string) (ContentBlock, error) {
	callID, _ := asString(field+".call_id", obj["call_id"])
	if callID == "" {
		return ContentBlock{}, &protoErr{field: field + ".call_id", reason: "call_id must not be empty"}
	}
	if _, ok := obj["output"]; !ok {
		return ContentBlock{}, &protoErr{field: field + ".output", reason: "tool output is required"}
	}
	output, err := StringifyToolArguments(obj["output"])
	if err != nil {
		return ContentBlock{}, &protoErr{field: field + ".output", reason: err.Error()}
	}
	if len(output) > MaxTextBlockLength {
		return ContentBlock{}, &protoErr{field: field + ".output", reason: "exceeds text length"}
	}
	return ContentBlock{
		Type:       BlockToolResult,
		Text:       output,
		ToolCallID: callID,
	}, nil
}

func decodeResponsesReasoningItemObj(obj map[string]any, field string) (map[string]any, error) {
	out := map[string]any{"type": "reasoning"}
	for _, k := range []string{"id", "encrypted_content"} {
		if v, ok := obj[k]; ok {
			s, err := asString(field+"."+k, v)
			if err != nil {
				return nil, err
			}
			out[k] = s
		}
	}
	if raw, ok := obj["summary"]; ok {
		list, err := asArray(field+".summary", raw)
		if err != nil {
			return nil, err
		}
		if len(list) > MaxBlocksPerMessage {
			return nil, &protoErr{field: field + ".summary", reason: "too many summary items"}
		}
		sum := make([]map[string]any, 0, len(list))
		for i, item := range list {
			ef := fmt.Sprintf("%s.summary[%d]", field, i)
			obj, err := asProto(ef, item)
			if err != nil {
				return nil, err
			}
			t, _ := obj["type"].(string)
			if t != "summary_text" && t != "reasoning_text" {
				return nil, &protoErr{field: ef + ".type", reason: "unsupported summary type"}
			}
			text, err := asString(ef+".text", obj["text"])
			if err != nil {
				return nil, err
			}
			if err := boundText(ef+".text", text); err != nil {
				return nil, err
			}
			sum = append(sum, map[string]any{"type": t, "text": text})
		}
		out["summary"] = sum
	}
	if err := boundJSON(field, out, MaxTextBlockLength); err != nil {
		return nil, err
	}
	return out, nil
}

func decodeResponsesAdditionalTools(raw any, field string) ([]Tool, error) {
	list, ok := raw.([]any)
	if !ok {
		return nil, nil
	}
	var tools []Tool
	for i, item := range list {
		obj, err := asProto(fmt.Sprintf("%s[%d]", field, i), item)
		if err != nil {
			return nil, err
		}
		if typ, _ := obj["type"].(string); typ != "additional_tools" {
			continue
		}
		nested, err := asArray(fmt.Sprintf("%s[%d].tools", field, i), obj["tools"])
		if err != nil {
			return nil, err
		}
		if len(nested) > MaxToolCount {
			return nil, &protoErr{field: fmt.Sprintf("%s[%d].tools", field, i), reason: "too many tools"}
		}
		for j, candidate := range nested {
			tool, err := decodeResponsesTool(candidate, fmt.Sprintf("%s[%d].tools[%d]", field, i, j))
			if err != nil {
				return nil, err
			}
			tools = append(tools, tool)
		}
	}
	return tools, nil
}

func decodeResponsesTool(raw any, field string) (Tool, error) {
	obj, err := asProto(field, raw)
	if err != nil {
		return Tool{}, err
	}
	t, _ := obj["type"].(string)
	switch t {
	case "function", "":
		name, _ := asString(field+".name", obj["name"])
		if name == "" {
			return Tool{}, &protoErr{field: field + ".name", reason: "tool name required"}
		}
		desc, _ := asString(field+".description", obj["description"])
		var schema map[string]any
		if raw, ok := obj["parameters"]; ok {
			schema, _ = asProto(field+".parameters", raw)
		}
		return Tool{Name: name, Description: desc, InputSchema: schema, Kind: ToolKindFunction}, nil
	case "web_search", "tool_search":
		return Tool{Name: t, Kind: ToolKindWebSearch, NativeType: t, NativeOptions: cloneMap(obj)}, nil
	case "custom", "namespace":
		name, _ := asString(field+".name", obj["name"])
		if name == "" {
			name, _ = asString(field+".namespace", obj["namespace"])
		}
		if name == "" {
			name = t
		}
		desc, _ := asString(field+".description", obj["description"])
		return Tool{Name: name, Description: desc, Kind: ToolKindCustom, NativeType: t, NativeOptions: cloneMap(obj)}, nil
	default:
		return Tool{}, &protoErr{field: field + ".type", reason: fmt.Sprintf("unsupported tool type %q", t)}
	}
}

func stringOf(v any) string {
	s, _ := v.(string)
	return s
}
