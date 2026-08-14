package transforms

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// AnthropicMessagesCodec implements request encoding for the Anthropic
// Messages wire surface.
type AnthropicMessagesCodec struct{}

// NewAnthropicMessagesCodec constructs an Anthropic encoder.
func NewAnthropicMessagesCodec() *AnthropicMessagesCodec { return &AnthropicMessagesCodec{} }

// Protocol reports the wire surface.
func (c *AnthropicMessagesCodec) Protocol() contracts.Protocol { return contracts.ProtocolAnthropic }

// Encode projects a canonical request onto /v1/messages.
//
// max_tokens is required by the Anthropic wire format. When the canonical
// request does not supply it, the encoder defaults to 4096 to keep the
// request well-formed without silently inventing a budget.
//
// Stream handling: req.Stream is forwarded verbatim. The encoder never
// drops the flag.
//
// Metadata is intentionally stripped on the Anthropic surface because
// Anthropic rejects unknown top-level keys; the encoder emits a
// DispositionUnsupported entry so observers can record the decision.
func (c *AnthropicMessagesCodec) Encode(ctx context.Context, req *NormalizedRequest) (*EncoderResult, *TransformError) {
	_ = ctx
	if req == nil {
		return nil, errEncode(contracts.ProtocolAnthropic, "request", "request must not be nil")
	}
	if err := req.Validate(); err != nil {
		return nil, errEncode(contracts.ProtocolAnthropic, "request", err.Error())
	}
	maxTokens := 4096
	if req.MaxOutputTokens != nil {
		maxTokens = *req.MaxOutputTokens
	}

	var systemText string
	convMsgs := []NormalizedMessage{}
	for _, m := range req.Messages {
		if m.Role == RoleSystem || m.Role == RoleDeveloper {
			t := messageText(m)
			if t == "" {
				continue
			}
			if systemText == "" {
				systemText = t
			} else {
				systemText += "\n\n" + t
			}
			continue
		}
		convMsgs = append(convMsgs, m)
	}

	payload := map[string]any{
		"model":      req.Model,
		"max_tokens": maxTokens,
		"stream":     req.Stream,
		"messages":   encodeAnthropicMessages(convMsgs),
	}
	var disp []FieldDisposition

	if systemText != "" {
		payload["system"] = systemText
		disp = append(disp, FieldDisposition{Path: "system", Action: DispositionAdapted})
	}
	if len(req.MCPServers) > 0 {
		payload["mcp_servers"] = cloneMapList(req.MCPServers)
		disp = append(disp, FieldDisposition{Path: "mcp_servers", Action: DispositionPreserved})
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			if t.NativeType != "" {
				if t.NativeType == "mcp_toolset" {
					tools = append(tools, mergeMap(map[string]any{"type": "mcp_toolset"}, t.NativeOptions))
					continue
				}
				tools = append(tools, mergeMap(map[string]any{"type": t.NativeType, "name": t.Name}, t.NativeOptions))
				continue
			}
			def := map[string]any{
				"name":         t.Name,
				"description":  nilIfEmpty(t.Description),
				"input_schema": t.InputSchema,
			}
			if t.DeferLoading != nil {
				def["defer_loading"] = *t.DeferLoading
			}
			if t.AllowedCallers != nil {
				def["allowed_callers"] = append([]string(nil), t.AllowedCallers...)
			}
			if t.InputExamples != nil {
				def["input_examples"] = cloneMapList(t.InputExamples)
			}
			tools = append(tools, def)
		}
		payload["tools"] = tools
		disp = append(disp, FieldDisposition{Path: "tools", Action: DispositionAdapted})
	}
	if req.ContextManagement != nil {
		payload["context_management"] = req.ContextManagement
		disp = append(disp, FieldDisposition{Path: "context_management", Action: DispositionPreserved})
	}
	if req.Reasoning == ReasoningEnabled && req.ReasoningConfig != nil {
		if req.ReasoningConfig.Effort != "" {
			payload["thinking"] = map[string]any{"type": "adaptive"}
			payload["output_config"] = map[string]any{"effort": string(req.ReasoningConfig.Effort)}
		} else {
			budget := req.ReasoningConfig.MaxTokens
			if budget == 0 {
				budget = maxTokens
			}
			if budget > 32000 {
				budget = 32000
			}
			payload["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
		}
		disp = append(disp, FieldDisposition{Path: "reasoning", Action: DispositionAdapted, TargetPath: "thinking"})
	}
	if req.Metadata != nil {
		// Anthropic rejects unknown top-level keys; record unsupported and
		// do not emit.
		disp = append(disp, FieldDisposition{Path: "metadata", Action: DispositionUnsupported, Reason: "anthropic rejects unknown top-level keys"})
	}

	applyPassthroughBucket(payload, req, "anthropic-messages")
	return &EncoderResult{Wire: payload, Dispositions: disp}, nil
}

func encodeAnthropicMessages(msgs []NormalizedMessage) []map[string]any {
	out := make([]map[string]any, 0, len(msgs))
	for _, m := range msgs {
		switch m.Role {
		case RoleUser:
			out = append(out, map[string]any{"role": "user", "content": encodeAnthropicUserBlocks(m.Content)})
		case RoleAssistant:
			blocks := make([]map[string]any, 0, len(m.Content))
			for _, b := range m.Content {
				switch b.Type {
				case BlockText:
					blocks = append(blocks, map[string]any{"type": "text", "text": b.Text})
				case BlockReasoning:
					if b.ReasoningText != "" {
						entry := map[string]any{"type": "thinking", "thinking": b.ReasoningText}
						if b.ReasoningSignature != "" {
							entry["signature"] = b.ReasoningSignature
						}
						blocks = append(blocks, entry)
					}
				case BlockCompaction:
					if b.Raw != nil {
						blocks = append(blocks, cloneMap(b.Raw))
					} else {
						blocks = append(blocks, map[string]any{"type": "compaction", "content": nilIfEmpty(b.Text)})
					}
				case BlockToolUse:
					blocks = append(blocks, encodeAnthropicToolUse(b))
				case BlockNative:
					if b.NativePayload != nil {
						blocks = append(blocks, cloneMap(b.NativePayload))
					}
				}
			}
			out = append(out, map[string]any{"role": "assistant", "content": blocks})
		case RoleTool:
			blocks := make([]map[string]any, 0, len(m.Content))
			for _, b := range m.Content {
				entry := map[string]any{
					"type":        "tool_result",
					"tool_use_id": b.ToolCallID,
					"content":     b.Text,
				}
				if b.ToolResultIsError {
					entry["is_error"] = true
				}
				if b.Raw != nil {
					entry["content"] = cloneMap(b.Raw)
				} else if b.Image != nil {
					entry["content"] = []map[string]any{{"type": "image", "source": encodeAnthropicImageSource(b.Image)}}
				}
				blocks = append(blocks, entry)
			}
			out = append(out, map[string]any{"role": "user", "content": blocks})
		case RoleSystem, RoleDeveloper:
			// Already collapsed into the `system` top-level field.
		}
	}
	return out
}

func encodeAnthropicUserBlocks(blocks []ContentBlock) []map[string]any {
	out := make([]map[string]any, 0, len(blocks))
	for _, b := range blocks {
		switch b.Type {
		case BlockText:
			entry := map[string]any{"type": "text", "text": b.Text}
			if b.CacheControl == "ephemeral" {
				entry["cache_control"] = map[string]any{"type": "ephemeral"}
			}
			out = append(out, entry)
		case BlockImage:
			out = append(out, map[string]any{"type": "image", "source": encodeAnthropicImageSource(b.Image)})
		case BlockToolResult:
			entry := map[string]any{
				"type":        "tool_result",
				"tool_use_id": b.ToolCallID,
				"content":     b.Text,
			}
			if b.ToolResultIsError {
				entry["is_error"] = true
			}
			out = append(out, entry)
		case BlockNative:
			if b.NativePayload != nil {
				out = append(out, cloneMap(b.NativePayload))
			}
		}
	}
	return out
}

func encodeAnthropicToolUse(b ContentBlock) map[string]any {
	raw := b.ToolArguments
	if raw == "" {
		raw = b.Text
	}
	if raw == "" {
		raw = "{}"
	}
	var input any
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		// Repair: try to wrap the value into an object so Anthropic's
		// strict input_schema validation does not fail on a malformed
		// tool-call argument.
		input = map[string]any{"_repaired": raw}
	}
	obj, _ := input.(map[string]any)
	if obj == nil {
		obj = map[string]any{}
	}
	entry := map[string]any{
		"type":  "tool_use",
		"id":    nilIfEmpty(b.ToolCallID),
		"name":  nilIfEmpty(b.ToolName),
		"input": obj,
	}
	if id, ok := entry["id"].(string); !ok || id == "" {
		entry["id"] = "toolu_" + b.ToolName
	}
	if name, ok := entry["name"].(string); !ok || name == "" {
		entry["name"] = b.ToolName
	}
	if b.ReasoningSignature != "" {
		entry["signature"] = b.ReasoningSignature
	}
	return entry
}

func encodeAnthropicImageSource(img *ImageReference) map[string]any {
	if img == nil {
		return map[string]any{"type": "url", "url": ""}
	}
	switch img.Kind {
	case ImageURL:
		return map[string]any{"type": "url", "url": img.Value}
	case ImageData:
		data := img.Value
		mt := img.MediaType
		if mt == "" {
			mt = "image/png"
		}
		if len(data) >= 5 && data[:5] == "data:" {
			if comma := indexByte(data, ','); comma >= 0 {
				mt = data[5:comma]
				if semi := indexByte(mt, ';'); semi >= 0 {
					mt = mt[:semi]
				}
				data = data[comma+1:]
			}
		}
		return map[string]any{"type": "base64", "media_type": mt, "data": data}
	default:
		return map[string]any{"type": "url", "url": ""}
	}
}

// AnthropicMessagesRequestDecoder implements the inbound side.
type AnthropicMessagesRequestDecoder struct{}

// NewAnthropicMessagesRequestDecoder constructs the decoder.
func NewAnthropicMessagesRequestDecoder() *AnthropicMessagesRequestDecoder {
	return &AnthropicMessagesRequestDecoder{}
}

// Protocol reports the wire surface.
func (d *AnthropicMessagesRequestDecoder) Protocol() contracts.Protocol {
	return contracts.ProtocolAnthropic
}

// Decode parses an Anthropic Messages body into a canonical request.
func (d *AnthropicMessagesRequestDecoder) Decode(ctx context.Context, body []byte, stream bool) (*NormalizedRequest, *TransformError) {
	_ = ctx
	root, err := decodeBody(body)
	if err != nil {
		return nil, errDecode(contracts.ProtocolAnthropic, "body", err.Error())
	}
	model, _ := asString("model", root["model"])
	if model == "" {
		return nil, errDecode(contracts.ProtocolAnthropic, "model", "model is required")
	}
	req := &NormalizedRequest{
		Model:          model,
		Stream:         stream,
		Source:         contracts.ProtocolAnthropic,
		ResponseFormat: FormatText,
	}

	if raw, ok := root["max_tokens"]; ok {
		v, err := asInt("max_tokens", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolAnthropic, "max_tokens", err.Error())
		}
		if v < 1 || v > MaxOutputTokens {
			return nil, errDecode(contracts.ProtocolAnthropic, "max_tokens", "max_tokens out of range")
		}
		req.MaxOutputTokens = &v
	} else {
		def := 4096
		req.MaxOutputTokens = &def
	}

	// Thinking / reasoning
	if raw, ok := root["thinking"]; ok && raw != nil {
		obj, err := asProto("thinking", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolAnthropic, "thinking", err.Error())
		}
		t, _ := obj["type"].(string)
		switch t {
		case "disabled":
			req.Reasoning = ReasoningDisabled
		case "enabled", "adaptive":
			req.Reasoning = ReasoningEnabled
			if budget, ok := obj["budget_tokens"]; ok {
				v, err := asInt("thinking.budget_tokens", budget)
				if err != nil {
					return nil, errDecode(contracts.ProtocolAnthropic, "thinking.budget_tokens", err.Error())
				}
				req.ReasoningConfig = &ReasoningConfig{MaxTokens: v}
			}
		default:
			return nil, errDecode(contracts.ProtocolAnthropic, "thinking.type", fmt.Sprintf("unsupported mode %q", t))
		}
	}
	if raw, ok := root["output_config"]; ok && raw != nil {
		obj, err := asProto("output_config", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolAnthropic, "output_config", err.Error())
		}
		if v, ok := obj["effort"]; ok {
			s, _ := v.(string)
			if e := normalizeClientEffort(s); e != "" {
				if req.ReasoningConfig == nil {
					req.ReasoningConfig = &ReasoningConfig{}
				}
				req.ReasoningConfig.Effort = e
			}
		}
	}

	if raw, ok := root["system"]; ok && raw != nil {
		if s, ok := raw.(string); ok {
			req.Messages = append(req.Messages, NormalizedMessage{
				Role:    RoleSystem,
				Content: []ContentBlock{{Type: BlockText, Text: s}},
			})
		} else {
			list, err := asArray("system", raw)
			if err != nil {
				return nil, errDecode(contracts.ProtocolAnthropic, "system", err.Error())
			}
			blocks := []ContentBlock{}
			for i, item := range list {
				obj, err := asProto(fmt.Sprintf("system[%d]", i), item)
				if err != nil {
					return nil, errDecode(contracts.ProtocolAnthropic, fmt.Sprintf("system[%d]", i), err.Error())
				}
				t, _ := obj["type"].(string)
				if t != "text" {
					return nil, errDecode(contracts.ProtocolAnthropic, fmt.Sprintf("system[%d].type", i), "unsupported system block type")
				}
				text, err := asString(fmt.Sprintf("system[%d].text", i), obj["text"])
				if err != nil {
					return nil, errDecode(contracts.ProtocolAnthropic, fmt.Sprintf("system[%d].text", i), err.Error())
				}
				cc := ""
				if ccObj, ok := obj["cache_control"].(map[string]any); ok && ccObj["type"] == "ephemeral" {
					cc = "ephemeral"
				}
				entry := ContentBlock{Type: BlockText, Text: text, CacheControl: cc}
				blocks = append(blocks, entry)
			}
			req.Messages = append(req.Messages, NormalizedMessage{Role: RoleSystem, Content: blocks})
		}
	}

	images := []ImageReference{}
	reasoningSeen := false
	if raw, ok := root["messages"]; ok {
		msgs, err := asArray("messages", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolAnthropic, "messages", err.Error())
		}
		if len(msgs) > MaxMessageCount {
			return nil, errDecode(contracts.ProtocolAnthropic, "messages", "too many messages")
		}
		for i, m := range msgs {
			field := fmt.Sprintf("messages[%d]", i)
			obj, err := asProto(field, m)
			if err != nil {
				return nil, errDecode(contracts.ProtocolAnthropic, field, err.Error())
			}
			role, err := roleFromString(field+".role", stringOf(obj["role"]))
			if err != nil {
				return nil, errDecode(contracts.ProtocolAnthropic, field+".role", err.Error())
			}
			if role == RoleDeveloper {
				return nil, errDecode(contracts.ProtocolAnthropic, field+".role", "developer role not allowed on anthropic messages")
			}
			content, err := decodeAnthropicContent(obj["content"], field+".content", &images, &reasoningSeen)
			if err != nil {
				return nil, errDecode(contracts.ProtocolAnthropic, field+".content", err.Error())
			}
			expanded := expandAnthropicToolResults(NormalizedMessage{Role: role, Content: content})
			if len(expanded) == 0 {
				req.Messages = append(req.Messages, NormalizedMessage{Role: role, Content: content})
			} else {
				// The expansion already contains the visible user/tool portions;
				// do not retain the source message as a duplicate.
				req.Messages = append(req.Messages, expanded...)
			}
		}
	}
	req.Images = images
	if reasoningSeen && req.Reasoning == ReasoningDefault {
		req.Reasoning = ReasoningEnabled
	}

	if raw, ok := root["tools"]; ok {
		list, err := asArray("tools", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolAnthropic, "tools", err.Error())
		}
		for i, t := range list {
			tool, err := decodeAnthropicTool(t, fmt.Sprintf("tools[%d]", i))
			if err != nil {
				return nil, errDecode(contracts.ProtocolAnthropic, fmt.Sprintf("tools[%d]", i), err.Error())
			}
			req.Tools = append(req.Tools, tool)
		}
	}
	if raw, ok := root["mcp_servers"]; ok {
		list, err := asArray("mcp_servers", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolAnthropic, "mcp_servers", err.Error())
		}
		for i, item := range list {
			obj, err := asProto(fmt.Sprintf("mcp_servers[%d]", i), item)
			if err != nil {
				return nil, errDecode(contracts.ProtocolAnthropic, fmt.Sprintf("mcp_servers[%d]", i), err.Error())
			}
			if err := boundJSON(fmt.Sprintf("mcp_servers[%d]", i), obj, MaxTextBlockLength); err != nil {
				return nil, errDecode(contracts.ProtocolAnthropic, fmt.Sprintf("mcp_servers[%d]", i), err.Error())
			}
			req.MCPServers = append(req.MCPServers, obj)
		}
	}
	if raw, ok := root["context_management"]; ok {
		obj, err := asProto("context_management", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolAnthropic, "context_management", err.Error())
		}
		req.ContextManagement = obj
	}
	if raw, ok := root["metadata"]; ok {
		obj, err := asProto("metadata", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolAnthropic, "metadata", err.Error())
		}
		req.Metadata = obj
	}

	if err := req.Validate(); err != nil {
		return nil, errDecode(contracts.ProtocolAnthropic, "request", err.Error())
	}
	return req, nil
}

// expandAnthropicToolResults follows the open-sse convention of splitting
// user messages that contain tool_result blocks into a text portion and a
// tool portion so downstream codecs can route the tool half to the
// canonical tool role.
func expandAnthropicToolResults(m NormalizedMessage) []NormalizedMessage {
	if m.Role != RoleUser {
		return nil
	}
	hasTools := false
	for _, b := range m.Content {
		if b.Type == BlockToolResult {
			hasTools = true
			break
		}
	}
	if !hasTools {
		return nil
	}
	var visible []ContentBlock
	var tools []ContentBlock
	var expanded []NormalizedMessage
	flush := func(role Role, blocks []ContentBlock) []ContentBlock {
		out := append([]ContentBlock(nil), blocks...)
		return out
	}
	for _, b := range m.Content {
		if b.Type == BlockToolResult {
			if len(visible) > 0 {
				expanded = append(expanded, NormalizedMessage{Role: RoleUser, Content: flush(RoleUser, visible)})
				visible = visible[:0]
			}
			tools = append(tools, b)
		} else {
			if len(tools) > 0 {
				expanded = append(expanded, NormalizedMessage{Role: RoleTool, Content: flush(RoleTool, tools)})
				tools = tools[:0]
			}
			visible = append(visible, b)
		}
	}
	if len(tools) > 0 {
		expanded = append(expanded, NormalizedMessage{Role: RoleTool, Content: flush(RoleTool, tools)})
	}
	if len(visible) > 0 {
		expanded = append(expanded, NormalizedMessage{Role: RoleUser, Content: flush(RoleUser, visible)})
	}
	return expanded
}

func decodeAnthropicContent(raw any, field string, images *[]ImageReference, reasoningSeen *bool) ([]ContentBlock, error) {
	if raw == nil {
		return nil, nil
	}
	if s, ok := raw.(string); ok {
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
		blockField := fmt.Sprintf("%s[%d]", field, i)
		obj, err := asProto(blockField, item)
		if err != nil {
			return nil, err
		}
		t, _ := obj["type"].(string)
		switch t {
		case "text":
			text, err := asString(blockField+".text", obj["text"])
			if err != nil {
				return nil, err
			}
			cc := ""
			if ccObj, ok := obj["cache_control"].(map[string]any); ok && ccObj["type"] == "ephemeral" {
				cc = "ephemeral"
			}
			out = append(out, ContentBlock{Type: BlockText, Text: text, CacheControl: cc})
		case "image":
			img, err := decodeAnthropicImage(obj["source"], blockField+".source", images)
			if err != nil {
				return nil, err
			}
			out = append(out, ContentBlock{Type: BlockImage, Image: &img})
		case "tool_use":
			id, err := asString(blockField+".id", obj["id"])
			if err != nil {
				return nil, err
			}
			if id == "" {
				return nil, &protoErr{field: blockField + ".id", reason: "tool use id must not be empty"}
			}
			name, err := asString(blockField+".name", obj["name"])
			if err != nil {
				return nil, err
			}
			if name == "" {
				return nil, &protoErr{field: blockField + ".name", reason: "tool use name must not be empty"}
			}
			input, err := asProto(blockField+".input", obj["input"])
			if err != nil {
				return nil, err
			}
			if err := boundJSON(blockField+".input", input, ToolArgumentLimit); err != nil {
				return nil, err
			}
			args, _ := json.Marshal(input)
			b := ContentBlock{
				Type:          BlockToolUse,
				ToolName:      name,
				ToolCallID:    id,
				ToolArguments: RepairToolCallArguments(string(args)),
			}
			if sig, ok := obj["signature"].(string); ok {
				if len(sig) > MaxTextBlockLength {
					return nil, &protoErr{field: blockField + ".signature", reason: "signature too long"}
				}
				b.ReasoningSignature = sig
			}
			out = append(out, b)
		case "tool_result":
			callID, err := asString(blockField+".tool_use_id", obj["tool_use_id"])
			if err != nil {
				return nil, err
			}
			if callID == "" {
				return nil, &protoErr{field: blockField + ".tool_use_id", reason: "tool_use_id must not be empty"}
			}
			isErr := obj["is_error"] == true
			content, err := decodeAnthropicToolResultContent(obj["content"], blockField+".content", callID, images, isErr)
			if err != nil {
				return nil, err
			}
			out = append(out, content...)
		case "thinking":
			text, err := asString(blockField+".thinking", obj["thinking"])
			if err != nil {
				return nil, err
			}
			b := ContentBlock{
				Type:          BlockReasoning,
				NativeType:    "thinking",
				NativePayload: cloneMap(obj),
				ReasoningText: text,
				Raw:           cloneMap(obj),
			}
			if sig, ok := obj["signature"].(string); ok {
				if len(sig) > MaxTextBlockLength {
					return nil, &protoErr{field: blockField + ".signature", reason: "signature too long"}
				}
				b.ReasoningSignature = sig
			}
			if reasoningSeen != nil {
				*reasoningSeen = true
			}
			out = append(out, b)
		case "compaction":
			content := obj["content"]
			if content != nil && content != "" {
				if _, ok := content.(string); !ok {
					return nil, &protoErr{field: blockField + ".content", reason: "expected a string or null"}
				}
			}
			out = append(out, ContentBlock{Type: BlockCompaction, Text: stringOf(content), Raw: cloneMap(obj)})
		default:
			if t == "" {
				return nil, &protoErr{field: blockField + ".type", reason: "missing block type"}
			}
			out = append(out, ContentBlock{Type: BlockNative, NativeType: t, NativePayload: cloneMap(obj), Raw: cloneMap(obj)})
		}
	}
	return out, nil
}

func decodeAnthropicToolResultContent(raw any, field, callID string, images *[]ImageReference, isErr bool) ([]ContentBlock, error) {
	if raw == nil {
		return []ContentBlock{{Type: BlockToolResult, ToolCallID: callID, ToolResultIsError: isErr}}, nil
	}
	if s, ok := raw.(string); ok {
		return []ContentBlock{{Type: BlockToolResult, Text: s, ToolCallID: callID, ToolResultIsError: isErr}}, nil
	}
	list, err := asArray(field, raw)
	if err != nil {
		return nil, err
	}
	if len(list) > MaxBlocksPerMessage {
		return nil, &protoErr{field: field, reason: "too many blocks"}
	}
	out := make([]ContentBlock, 0, len(list))
	for i, item := range list {
		itemField := fmt.Sprintf("%s[%d]", field, i)
		obj, err := asProto(itemField, item)
		if err != nil {
			return nil, err
		}
		t, _ := obj["type"].(string)
		switch t {
		case "text":
			text, err := asString(itemField+".text", obj["text"])
			if err != nil {
				return nil, err
			}
			out = append(out, ContentBlock{Type: BlockToolResult, Text: text, ToolCallID: callID, ToolResultIsError: isErr})
		case "image":
			img, err := decodeAnthropicImage(obj["source"], itemField+".source", images)
			if err != nil {
				return nil, err
			}
			out = append(out, ContentBlock{Type: BlockToolResult, Image: &img, ToolCallID: callID, ToolResultIsError: isErr})
		default:
			if t == "" {
				return nil, &protoErr{field: itemField + ".type", reason: "missing block type"}
			}
			out = append(out, ContentBlock{
				Type:              BlockToolResult,
				ToolCallID:        callID,
				ToolResultIsError: isErr,
				NativeType:        t,
				NativePayload:     cloneMap(obj),
				Raw:               cloneMap(obj),
			})
		}
	}
	return out, nil
}

func decodeAnthropicImage(raw any, field string, images *[]ImageReference) (ImageReference, error) {
	obj, err := asProto(field, raw)
	if err != nil {
		return ImageReference{}, err
	}
	t, _ := obj["type"].(string)
	switch t {
	case "base64":
		mt, err := asString(field+".media_type", obj["media_type"])
		if err != nil {
			return ImageReference{}, err
		}
		if mt == "" {
			return ImageReference{}, &protoErr{field: field + ".media_type", reason: "media_type must not be empty"}
		}
		data, err := asString(field+".data", obj["data"])
		if err != nil {
			return ImageReference{}, err
		}
		if data == "" {
			return ImageReference{}, &protoErr{field: field + ".data", reason: "base64 data must not be empty"}
		}
		ref := ImageReference{Kind: ImageData, Value: data, MediaType: mt}
		*images = append(*images, ref)
		return ref, nil
	case "url":
		s, err := asString(field+".url", obj["url"])
		if err != nil {
			return ImageReference{}, err
		}
		ref := classifyImageReference(s)
		*images = append(*images, ref)
		return ref, nil
	default:
		return ImageReference{}, &protoErr{field: field + ".type", reason: fmt.Sprintf("unsupported image source type %q", t)}
	}
}

func decodeAnthropicTool(raw any, field string) (Tool, error) {
	obj, err := asProto(field, raw)
	if err != nil {
		return Tool{}, err
	}
	t, _ := obj["type"].(string)
	if t == "mcp_toolset" {
		return Tool{
			Name:          "mcp_toolset",
			NativeType:    "mcp_toolset",
			NativeOptions: cloneMap(obj),
		}, nil
	}
	name, err := asString(field+".name", obj["name"])
	if err != nil {
		return Tool{}, err
	}
	if name == "" {
		return Tool{}, &protoErr{field: field + ".name", reason: "tool name required"}
	}
	desc, _ := asString(field+".description", obj["description"])
	schemaRaw := obj["input_schema"]
	schema, err := asProto(field+".input_schema", schemaRaw)
	if err != nil {
		return Tool{}, err
	}
	tool := Tool{Name: name, Description: desc, InputSchema: schema}
	if d, ok := obj["defer_loading"].(bool); ok {
		tool.DeferLoading = &d
	}
	if raw, ok := obj["allowed_callers"]; ok {
		if list, ok := raw.([]any); ok {
			for i, x := range list {
				s, ok := x.(string)
				if !ok {
					return Tool{}, &protoErr{field: fmt.Sprintf("%s.allowed_callers[%d]", field, i), reason: "expected a string"}
				}
				tool.AllowedCallers = append(tool.AllowedCallers, s)
			}
		}
	}
	return tool, nil
}
