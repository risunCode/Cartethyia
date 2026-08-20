package codec

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// GeminiCodec implements the native Gemini generateContent request surface.
// It deliberately owns Gemini's contents/parts grammar rather than pivoting
// through an OpenAI-shaped body.
type GeminiCodec struct{}

func NewGeminiCodec() *GeminiCodec                  { return &GeminiCodec{} }
func (c *GeminiCodec) Protocol() contracts.Protocol { return contracts.ProtocolGemini }

// GeminiRequestDecoder decodes native Gemini generateContent JSON into the
// canonical request model. The model is accepted in the body because the
// public route may be backed by a model-path route or a direct JSON fixture.
type GeminiRequestDecoder struct{}

func NewGeminiRequestDecoder() *GeminiRequestDecoder         { return &GeminiRequestDecoder{} }
func (d *GeminiRequestDecoder) Protocol() contracts.Protocol { return contracts.ProtocolGemini }

func (d *GeminiRequestDecoder) Decode(ctx context.Context, body []byte, stream bool) (*NormalizedRequest, *TransformError) {
	if err := ctx.Err(); err != nil {
		return nil, newTransformError(CodeContextCanceled, "decode-request", string(contracts.ProtocolGemini), "context", "transform canceled", err)
	}
	root, err := decodeBody(body)
	if err != nil {
		return nil, errDecode(contracts.ProtocolGemini, "body", err.Error())
	}
	model := stringOf(root["model"])
	if model == "" {
		model = stringOf(root["model_name"])
	}
	if model == "" {
		return nil, errDecode(contracts.ProtocolGemini, "model", "model is required")
	}
	if len(model) > MaxModelLength {
		return nil, errDecode(contracts.ProtocolGemini, "model", "model exceeds maximum length")
	}
	req := &NormalizedRequest{Model: model, Stream: stream, Source: contracts.ProtocolGemini, ResponseFormat: FormatText}

	if raw, ok := root["systemInstruction"]; ok {
		content, err := decodeGeminiInstruction(raw, "systemInstruction")
		if err != nil {
			return nil, errDecode(contracts.ProtocolGemini, "systemInstruction", err.Error())
		}
		if len(content) > 0 {
			req.Messages = append(req.Messages, NormalizedMessage{Role: RoleSystem, Content: content})
		}
	}
	if raw, ok := root["contents"]; ok {
		contents, err := asArray("contents", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolGemini, "contents", err.Error())
		}
		if len(contents) > MaxMessageCount {
			return nil, errDecode(contracts.ProtocolGemini, "contents", "too many contents")
		}
		for i, item := range contents {
			field := fmt.Sprintf("contents[%d]", i)
			obj, err := asProto(field, item)
			if err != nil {
				return nil, errDecode(contracts.ProtocolGemini, field, err.Error())
			}
			role := RoleUser
			if stringOf(obj["role"]) == "model" {
				role = RoleAssistant
			}
			parts, err := decodeGeminiParts(obj["parts"], field+".parts")
			if err != nil {
				return nil, errDecode(contracts.ProtocolGemini, field+".parts", err.Error())
			}
			for _, part := range parts {
				if part.Type == BlockToolResult {
					role = RoleTool
					break
				}
			}
			req.Messages = append(req.Messages, NormalizedMessage{Role: role, Content: parts})
		}
	}
	if raw, ok := root["generationConfig"]; ok {
		if err := decodeGeminiGenerationConfig(req, raw); err != nil {
			return nil, errDecode(contracts.ProtocolGemini, "generationConfig", err.Error())
		}
	}
	if raw, ok := root["toolConfig"]; ok {
		obj, err := asProto("toolConfig", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolGemini, "toolConfig", err.Error())
		}
		if fn, ok := obj["functionCallingConfig"].(map[string]any); ok {
			mode := strings.ToLower(stringOf(fn["mode"]))
			switch mode {
			case "none", "auto", "any", "required":
				req.ToolChoice = &ToolChoice{Mode: mapGeminiToolMode(mode)}
			case "":
			default:
				return nil, errDecode(contracts.ProtocolGemini, "toolConfig.functionCallingConfig.mode", "unsupported function calling mode")
			}
		}
	}
	if raw, ok := root["tools"]; ok {
		tools, err := decodeGeminiTools(raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolGemini, "tools", err.Error())
		}
		req.Tools = tools
	}
	if raw, ok := root["cachedContent"]; ok {
		req.CacheKey = stringOf(raw)
	}
	if raw, ok := root["metadata"]; ok {
		metadata, err := asProto("metadata", raw)
		if err != nil {
			return nil, errDecode(contracts.ProtocolGemini, "metadata", err.Error())
		}
		req.Metadata = metadata
	}
	if req.Reasoning == "" {
		req.Reasoning = ReasoningDefault
	}
	if err := req.Validate(); err != nil {
		return nil, errDecode(contracts.ProtocolGemini, "request", err.Error())
	}
	return req, nil
}

func decodeGeminiInstruction(raw any, field string) ([]ContentBlock, error) {
	if s, ok := raw.(string); ok {
		return []ContentBlock{{Type: BlockText, Text: s}}, nil
	}
	obj, err := asProto(field, raw)
	if err != nil {
		return nil, err
	}
	return decodeGeminiParts(obj["parts"], field+".parts")
}

func decodeGeminiParts(raw any, field string) ([]ContentBlock, error) {
	list, err := asArray(field, raw)
	if err != nil {
		return nil, err
	}
	if len(list) > MaxBlocksPerMessage {
		return nil, &protoErr{field: field, reason: "too many parts"}
	}
	out := make([]ContentBlock, 0, len(list))
	for i, item := range list {
		partField := fmt.Sprintf("%s[%d]", field, i)
		obj, err := asProto(partField, item)
		if err != nil {
			return nil, err
		}
		switch {
		case obj["text"] != nil:
			text, err := asString(partField+".text", obj["text"])
			if err != nil {
				return nil, err
			}
			b := ContentBlock{Type: BlockText, Text: text}
			if thought, ok := obj["thought"].(bool); ok && thought {
				b.Type = BlockReasoning
				b.ReasoningText = text
				b.NativeType = "thought"
				b.NativePayload = cloneMap(obj)
			}
			if sig := stringOf(obj["thoughtSignature"]); sig != "" {
				b.ReasoningSignature = sig
			}
			out = append(out, b)
		case obj["inlineData"] != nil:
			media, err := decodeGeminiMedia(obj["inlineData"], partField+".inlineData", ReferenceInlineData)
			if err != nil {
				return nil, err
			}
			out = append(out, geminiMediaBlock(media))
		case obj["fileData"] != nil:
			media, err := decodeGeminiMedia(obj["fileData"], partField+".fileData", ReferenceProviderFileURL)
			if err != nil {
				return nil, err
			}
			out = append(out, geminiMediaBlock(media))
		case obj["functionCall"] != nil:
			call, err := asProto(partField+".functionCall", obj["functionCall"])
			if err != nil {
				return nil, err
			}
			name := stringOf(call["name"])
			if name == "" {
				return nil, &protoErr{field: partField + ".functionCall.name", reason: "function name is required"}
			}
			args, err := StringifyToolArguments(call["args"])
			if err != nil {
				return nil, err
			}
			callID := firstNonEmpty(stringOf(call["id"]), stringOf(call["callId"]))
			if callID == "" {
				callID = "call_" + name
			}
			out = append(out, ContentBlock{Type: BlockToolUse, ToolName: name, ToolCallID: callID, ToolArguments: RepairToolCallArguments(args)})
		case obj["functionResponse"] != nil:
			response, err := asProto(partField+".functionResponse", obj["functionResponse"])
			if err != nil {
				return nil, err
			}
			name := stringOf(response["name"])
			callID := firstNonEmpty(stringOf(response["id"]), stringOf(response["callId"]))
			if callID == "" {
				callID = "call_" + name
			}
			if _, ok := response["response"]; !ok {
				return nil, &protoErr{field: partField + ".functionResponse.response", reason: "function response is required"}
			}
			value, err := StringifyToolArguments(response["response"])
			if err != nil {
				return nil, err
			}
			out = append(out, ContentBlock{Type: BlockToolResult, ToolName: name, ToolCallID: callID, Text: value, ToolResult: value})
		case obj["executableCode"] != nil, obj["codeExecutionResult"] != nil:
			out = append(out, ContentBlock{Type: BlockNative, NativeType: firstNonEmpty(stringOf(obj["type"]), "code"), NativePayload: cloneMap(obj), Raw: cloneMap(obj)})
		default:
			return nil, &protoErr{field: partField, reason: "unsupported Gemini part"}
		}
	}
	return out, nil
}

func decodeGeminiMedia(raw any, field string, reference ReferenceKind) (MediaReference, error) {
	obj, err := asProto(field, raw)
	if err != nil {
		return MediaReference{}, err
	}
	mime := stringOf(obj["mimeType"])
	value := firstNonEmpty(stringOf(obj["data"]), stringOf(obj["fileUri"]))
	if value == "" {
		return MediaReference{}, &protoErr{field: field, reason: "media data or fileUri is required"}
	}
	mediaKind := MediaGenericFile
	if strings.HasPrefix(mime, "image/") {
		mediaKind = MediaImage
	} else if strings.HasPrefix(mime, "audio/") {
		mediaKind = MediaAudio
	} else if mime == "application/pdf" {
		mediaKind = MediaPDF
	} else if strings.HasPrefix(mime, "text/") {
		mediaKind = MediaTextDocument
	}
	media, transformErr := NewMediaReference(mediaKind, reference, value, MediaReferenceOptions{MIMEType: mime})
	if transformErr != nil {
		return MediaReference{}, transformErr
	}
	return media, nil
}

func geminiMediaBlock(media MediaReference) ContentBlock {
	block := ContentBlock{Type: BlockFile, Media: &media}
	switch media.Media {
	case MediaImage:
		block.Type = BlockImage
		ref := ImageReference{Kind: ImageData, Value: media.Value, MediaType: media.MIMEType}
		if media.Reference != ReferenceInlineData {
			ref.Kind = ImageFile
		}
		block.Image = &ref
	case MediaAudio:
		block.Type = BlockAudio
		block.Audio = &media
	case MediaTextDocument:
		block.Type = BlockDocument
		block.Document = &media
	case MediaPDF:
		block.Type = BlockPDF
		block.Document = &media
	}
	return block
}

func decodeGeminiGenerationConfig(req *NormalizedRequest, raw any) error {
	obj, err := asProto("generationConfig", raw)
	if err != nil {
		return err
	}
	if v, ok := obj["maxOutputTokens"]; ok {
		n, err := asInt("generationConfig.maxOutputTokens", v)
		if err != nil {
			return err
		}
		req.MaxOutputTokens = &n
	}
	if v, ok := obj["temperature"]; ok {
		n, err := asFloat("generationConfig.temperature", v)
		if err != nil {
			return err
		}
		req.Temperature = &n
	}
	if v, ok := obj["topP"]; ok {
		n, err := asFloat("generationConfig.topP", v)
		if err != nil {
			return err
		}
		req.TopP = &n
	}
	if v, ok := obj["stopSequences"]; ok {
		list, err := asArray("generationConfig.stopSequences", v)
		if err != nil {
			return err
		}
		for i, item := range list {
			s, err := asString(fmt.Sprintf("generationConfig.stopSequences[%d]", i), item)
			if err != nil {
				return err
			}
			req.Stop = append(req.Stop, s)
		}
	}
	if mime := stringOf(obj["responseMimeType"]); mime != "" {
		switch mime {
		case "application/json":
			req.ResponseFormat = FormatJSONObject
		case "text/plain":
			req.ResponseFormat = FormatText
		default:
			return &protoErr{field: "generationConfig.responseMimeType", reason: "unsupported response MIME type"}
		}
	}
	if schema, ok := obj["responseSchema"]; ok {
		parsed, err := asProto("generationConfig.responseSchema", schema)
		if err != nil {
			return err
		}
		req.ResponseFormat = FormatJSONSchema
		req.ResponseFormatSchema = parsed
	}
	if thinking, ok := obj["thinkingConfig"].(map[string]any); ok {
		req.Reasoning = ReasoningEnabled
		cfg := &ReasoningConfig{Enabled: true}
		if b, ok := thinking["includeThoughts"].(bool); ok {
			cfg.Enabled = b
		}
		if n, ok := thinking["thinkingBudget"].(float64); ok {
			cfg.MaxTokens = int(n)
		}
		req.ReasoningConfig = cfg
	}
	return nil
}

func decodeGeminiTools(raw any) ([]Tool, error) {
	list, err := asArray("tools", raw)
	if err != nil {
		return nil, err
	}
	if len(list) > MaxToolCount {
		return nil, &protoErr{field: "tools", reason: "too many tools"}
	}
	var out []Tool
	for i, item := range list {
		obj, err := asProto(fmt.Sprintf("tools[%d]", i), item)
		if err != nil {
			return nil, err
		}
		if declarations, ok := obj["functionDeclarations"].([]any); ok {
			for j, rawDecl := range declarations {
				field := fmt.Sprintf("tools[%d].functionDeclarations[%d]", i, j)
				decl, err := asProto(field, rawDecl)
				if err != nil {
					return nil, err
				}
				name := stringOf(decl["name"])
				if name == "" {
					return nil, &protoErr{field: field + ".name", reason: "tool name is required"}
				}
				schema, _ := asProto(field+".parameters", decl["parameters"])
				out = append(out, Tool{Name: name, Description: stringOf(decl["description"]), InputSchema: schema, Kind: ToolKindFunction})
			}
			continue
		}
		typ := firstNonEmpty(stringOf(obj["type"]), stringOf(obj["name"]))
		if typ == "" {
			return nil, &protoErr{field: fmt.Sprintf("tools[%d]", i), reason: "tool declaration is missing type"}
		}
		out = append(out, Tool{Name: typ, Kind: ToolKindNative, NativeType: typ, NativeOptions: cloneMap(obj)})
	}
	return out, nil
}

func mapGeminiToolMode(mode string) string {
	if mode == "any" {
		return "required"
	}
	return mode
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func (c *GeminiCodec) Encode(ctx context.Context, req *NormalizedRequest) (*EncoderResult, *TransformError) {
	if err := ctx.Err(); err != nil {
		return nil, newTransformError(CodeContextCanceled, "encode-request", string(contracts.ProtocolGemini), "context", "transform canceled", err)
	}
	if req == nil {
		return nil, errEncode(contracts.ProtocolGemini, "request", "request must not be nil")
	}
	if err := req.Validate(); err != nil {
		return nil, errEncode(contracts.ProtocolGemini, "request", err.Error())
	}
	if err := validateGeminiRequestBlocks(req.Messages); err != nil {
		return nil, err
	}
	responseFormat, responseSchema, formatErr := effectiveResponseFormat(contracts.ProtocolGemini, req)
	if formatErr != nil {
		return nil, formatErr
	}
	payload := map[string]any{"model": req.Model, "contents": []map[string]any{}}
	var systemParts []map[string]any
	contents := payload["contents"].([]map[string]any)
	for _, message := range req.Messages {
		if message.Role == RoleSystem || message.Role == RoleDeveloper {
			systemParts = append(systemParts, encodeGeminiParts(message.Content)...)
			continue
		}
		role := "user"
		if message.Role == RoleAssistant {
			role = "model"
		}
		contents = append(contents, map[string]any{"role": role, "parts": encodeGeminiParts(message.Content)})
	}
	if len(contents) > 0 {
		payload["contents"] = contents
	} else {
		delete(payload, "contents")
	}
	if len(systemParts) > 0 {
		payload["systemInstruction"] = map[string]any{"parts": systemParts}
	}
	if len(req.Tools) > 0 {
		payload["tools"] = encodeGeminiTools(req.Tools)
	}
	if req.ToolChoice != nil {
		payload["toolConfig"] = map[string]any{"functionCallingConfig": map[string]any{"mode": geminiToolMode(req.ToolChoice.Mode)}}
	}
	generation := map[string]any{}
	if req.MaxOutputTokens != nil {
		generation["maxOutputTokens"] = *req.MaxOutputTokens
	}
	if req.Temperature != nil {
		generation["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		generation["topP"] = *req.TopP
	}
	if len(req.Stop) > 0 {
		generation["stopSequences"] = append([]string(nil), req.Stop...)
	}
	switch responseFormat {
	case FormatJSONObject:
		generation["responseMimeType"] = "application/json"
	case FormatJSONSchema:
		generation["responseMimeType"] = "application/json"
		generation["responseSchema"] = cloneMap(responseSchema)
	}
	if req.Reasoning == ReasoningEnabled || req.ReasoningConfig != nil {
		thinking := map[string]any{"includeThoughts": true}
		if req.ReasoningConfig != nil && req.ReasoningConfig.MaxTokens > 0 {
			thinking["thinkingBudget"] = req.ReasoningConfig.MaxTokens
		}
		generation["thinkingConfig"] = thinking
	}
	if len(generation) > 0 {
		payload["generationConfig"] = generation
	}
	if req.CacheKey != "" {
		payload["cachedContent"] = req.CacheKey
	}
	if req.Metadata != nil && req.Source == contracts.ProtocolGemini {
		payload["metadata"] = cloneMap(req.Metadata)
	}
	if err := validateGeminiWire(payload); err != nil {
		return nil, err
	}
	return &EncoderResult{Wire: payload, Dispositions: []FieldDisposition{{Path: "contents", Action: DispositionPreserved}}}, nil
}

func validateGeminiRequestBlocks(messages []NormalizedMessage) *TransformError {
	for mi, message := range messages {
		for bi, block := range message.Content {
			field := fmt.Sprintf("messages[%d].content[%d]", mi, bi)
			switch block.Type {
			case BlockToolUse:
				value := firstNonEmpty(block.ToolArguments, block.Text)
				if value == "" {
					value = "{}"
				}
				var object map[string]any
				if err := json.Unmarshal([]byte(value), &object); err != nil || object == nil {
					return newTransformError(CodeInvalidRequest, "encode-request", string(contracts.ProtocolGemini), field+".arguments", "Gemini function arguments must be a JSON object", nil)
				}
			case BlockToolResult:
				if block.ToolResultIsError {
					continue
				}
				if firstNonEmpty(block.ToolResult, block.Text) == "" && len(block.ToolResultMedia) == 0 {
					return newTransformError(CodeInvalidRequest, "encode-request", string(contracts.ProtocolGemini), field, "tool result must contain visible content", nil)
				}
			}
		}
	}
	return nil
}

func encodeGeminiParts(blocks []ContentBlock) []map[string]any {
	parts := make([]map[string]any, 0, len(blocks))
	for _, block := range blocks {
		switch block.Type {
		case BlockText:
			parts = append(parts, map[string]any{"text": block.Text})
		case BlockReasoning:
			entry := map[string]any{"text": block.ReasoningText, "thought": true}
			if block.ReasoningSignature != "" {
				entry["thoughtSignature"] = block.ReasoningSignature
			}
			parts = append(parts, entry)
		case BlockImage:
			if block.Image != nil {
				media := MediaReference{Media: MediaImage, MIMEType: block.Image.MediaType, Filename: block.Image.Filename, Value: block.Image.Value}
				switch block.Image.Kind {
				case ImageData:
					media.Reference = ReferenceInlineData
				case ImageFile:
					media.Reference = ReferenceProviderFileID
				default:
					media.Reference = ReferenceURL
				}
				parts = append(parts, encodeGeminiMedia(&media))
			}
		case BlockAudio, BlockFile, BlockDocument, BlockPDF:
			if media := contentMediaReference(block); media != nil {
				parts = append(parts, encodeGeminiMedia(media))
			}
		case BlockToolUse:
			args := map[string]any{}
			if block.ToolArguments != "" {
				if err := json.Unmarshal([]byte(block.ToolArguments), &args); err != nil {
					continue
				}
			}
			call := map[string]any{"name": block.ToolName, "args": args}
			if block.ToolCallID != "" {
				call["id"] = block.ToolCallID
			}
			parts = append(parts, map[string]any{"functionCall": call})
		case BlockToolResult, BlockServerToolResult:
			response := map[string]any{}
			value := firstNonEmpty(block.ToolResult, block.Text)
			if value != "" {
				if err := json.Unmarshal([]byte(value), &response); err != nil {
					response["result"] = value
				}
			}
			call := map[string]any{"name": block.ToolName, "response": response}
			if block.ToolCallID != "" {
				call["id"] = block.ToolCallID
			}
			parts = append(parts, map[string]any{"functionResponse": call})
			for _, media := range block.ToolResultMedia {
				parts = append(parts, encodeGeminiMedia(&media))
			}
		case BlockNative, BlockUnknown:
			if block.NativePayload != nil {
				parts = append(parts, cloneMap(block.NativePayload))
			} else if block.Raw != nil {
				parts = append(parts, cloneMap(block.Raw))
			}
		}
	}
	return parts
}

func encodeGeminiMedia(media *MediaReference) map[string]any {
	if media == nil {
		return map[string]any{"inlineData": map[string]any{"mimeType": "application/octet-stream", "data": ""}}
	}
	key, valueKey := "fileData", "fileUri"
	if media.Reference == ReferenceInlineData {
		key, valueKey = "inlineData", "data"
	}
	entry := map[string]any{valueKey: media.Value}
	if media.MIMEType != "" {
		entry["mimeType"] = media.MIMEType
	}
	return map[string]any{key: entry}
}

func encodeGeminiTools(tools []Tool) []map[string]any {
	declarations := make([]map[string]any, 0, len(tools))
	native := make([]map[string]any, 0)
	for _, tool := range tools {
		if tool.NativeType != "" || (tool.Kind != "" && tool.Kind != ToolKindFunction) {
			value := cloneMap(tool.NativeOptions)
			if value == nil {
				value = map[string]any{}
			}
			if tool.NativeType != "" {
				value["type"] = tool.NativeType
			}
			native = append(native, value)
			continue
		}
		declaration := map[string]any{"name": tool.Name, "parameters": tool.InputSchema}
		if tool.Description != "" {
			declaration["description"] = tool.Description
		}
		declarations = append(declarations, declaration)
	}
	out := make([]map[string]any, 0, 1+len(native))
	if len(declarations) > 0 {
		out = append(out, map[string]any{"functionDeclarations": declarations})
	}
	out = append(out, native...)
	return out
}

func geminiToolMode(mode string) string {
	switch mode {
	case "none":
		return "NONE"
	case "required":
		return "ANY"
	default:
		return "AUTO"
	}
}

func validateGeminiWire(payload map[string]any) *TransformError {
	if payload == nil || stringOf(payload["model"]) == "" {
		return errEncode(contracts.ProtocolGemini, "model", "model is required")
	}
	if contents, ok := payload["contents"]; ok {
		if _, ok := contents.([]map[string]any); !ok {
			return errEncode(contracts.ProtocolGemini, "contents", "contents must be an array")
		}
	}
	if _, err := json.Marshal(payload); err != nil {
		return errEncode(contracts.ProtocolGemini, "body", "target schema validation failed")
	}
	return nil
}
