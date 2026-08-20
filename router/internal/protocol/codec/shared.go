package codec

import (
	"encoding/json"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// errEncode wraps a validation failure during encoding.
func errEncode(surface contracts.Protocol, field, reason string) *TransformError {
	return newTransformError(CodeInvalidRequest, "encode-request", string(surface), field, reason, nil)
}

// errDecode wraps a validation failure during decoding.
func errDecode(surface contracts.Protocol, field, reason string) *TransformError {
	return newTransformError(CodeInvalidRequest, "decode-request", string(surface), field, reason, nil)
}

// errDecodeResponse wraps a validation failure during response decoding.
func errDecodeResponse(surface contracts.Protocol, field, reason string) *TransformError {
	return newTransformError(CodeInvalidRequest, "decode-response", string(surface), field, reason, nil)
}

// errEncodeResponse wraps a validation failure during response encoding.
func errEncodeResponse(surface contracts.Protocol, field, reason string) *TransformError {
	return newTransformError(CodeInvalidRequest, "encode-response", string(surface), field, reason, nil)
}

// validateWirePayload is the final target-schema seam. It intentionally runs
// after all provider policy projection and before the body is marshaled by the
// caller: values must be a finite JSON object and the required top-level
// surface shape must be present. It does not recursively reinterpret provider
// schemas or silently repair malformed values.
func validateWirePayload(surface contracts.Protocol, payload map[string]any) *TransformError {
	if payload == nil {
		return errEncode(surface, "body", "target payload must not be nil")
	}
	if _, err := json.Marshal(payload); err != nil {
		return errEncode(surface, "body", "target schema validation failed")
	}
	if stringOf(payload["model"]) == "" {
		return errEncode(surface, "model", "target model is required")
	}
	switch surface {
	case contracts.ProtocolOpenAIChat, contracts.ProtocolAnthropic:
		if _, ok := payload["messages"].([]map[string]any); !ok {
			return errEncode(surface, "messages", "target messages must be an array")
		}
	case contracts.ProtocolOpenAIResponse:
		if _, ok := payload["input"].([]map[string]any); !ok {
			return errEncode(surface, "input", "target input must be an array")
		}
	}
	return nil
}

func effectiveResponseFormat(surface contracts.Protocol, req *NormalizedRequest) (ResponseFormat, map[string]any, *TransformError) {
	if req == nil {
		return "", nil, errEncode(surface, "request", "request must not be nil")
	}
	format, schema := req.ResponseFormat, req.ResponseFormatSchema
	if format == "" {
		format = FormatText
	}
	if req.StructuredOutput == nil {
		return format, schema, nil
	}
	format = req.StructuredOutput.Format
	if len(req.StructuredOutput.Schema) == 0 {
		return format, schema, nil
	}
	var decoded map[string]any
	if err := json.Unmarshal(req.StructuredOutput.Schema, &decoded); err != nil || decoded == nil {
		return "", nil, errEncode(surface, "structured_output.schema", "schema must be a JSON object")
	}
	return format, decoded, nil
}

// nilIfEmpty returns nil when the string is empty so json.Marshal omits
// the key. Used to keep wire payloads compact for optional tool
// description fields.
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// normalizeClientEffort maps an arbitrary client effort string onto the
// canonical ReasoningEffort vocabulary. Unknown values yield "" so the
// caller can drop the field rather than invent semantics.
func normalizeClientEffort(s string) ReasoningEffort {
	switch s {
	case "xhigh":
		return EffortXHigh
	case "high":
		return EffortHigh
	case "medium":
		return EffortMedium
	case "low":
		return EffortLow
	case "minimal":
		return EffortMinimal
	case "none":
		return EffortNone
	default:
		return ""
	}
}

// projectEffort returns the wire literal for a given reasoning effort on
// a target surface. Most surfaces accept the canonical spelling; the
// Anthropic adapter accepts only the canonical vocabulary as well.
func projectEffort(effort ReasoningEffort, _ contracts.Protocol, _ []string) string {
	if effort == "" {
		return ""
	}
	return string(effort)
}

// parseReasoningConfig decodes a Responses / Chat `reasoning` object into
// the canonical ReasoningConfig + flag pair. It mirrors the legacy
// openai-responses.parseReasoningConfig in semantic.
func parseReasoningConfig(obj map[string]any, field string, enabledVal any) (ReasoningFlag, *ReasoningConfig, error) {
	cfg := &ReasoningConfig{}
	if b, err := asBool(field+".enabled", enabledVal); err == nil && enabledVal != nil {
		if !b {
			return ReasoningDisabled, &ReasoningConfig{Enabled: false}, nil
		}
		cfg.Enabled = true
	}
	if v, ok := obj["effort"]; ok {
		if s, ok := v.(string); ok && s != "" {
			cfg.Effort = normalizeClientEffort(s)
		}
	}
	if v, ok := obj["summary"]; ok {
		s, _ := v.(string)
		switch s {
		case "auto":
			cfg.Summary = SummaryAuto
		case "concise":
			cfg.Summary = SummaryConcise
		case "detailed":
			cfg.Summary = SummaryDetailed
		default:
			if s != "" {
				return "", nil, &protoErr{field: field + ".summary", reason: "unsupported value"}
			}
		}
	}
	if v, ok := obj["max_tokens"]; ok {
		n, err := asInt(field+".max_tokens", v)
		if err != nil {
			return "", nil, err
		}
		cfg.MaxTokens = n
	}
	if v, ok := obj["exclude"]; ok {
		b, _ := v.(bool)
		cfg.Exclude = b
	}
	if v, ok := obj["mode"]; ok {
		s, _ := v.(string)
		switch s {
		case "standard":
			cfg.Mode = ReasoningModeStandard
		case "pro":
			cfg.Mode = ReasoningModePro
		default:
			if s != "" {
				return "", nil, &protoErr{field: field + ".mode", reason: "unsupported value"}
			}
		}
	}
	if v, ok := obj["context"]; ok {
		s, _ := v.(string)
		switch s {
		case "auto":
			cfg.Context = ReasoningContextAuto
		case "current_turn":
			cfg.Context = ReasoningContextCurrentTurn
		case "all_turns":
			cfg.Context = ReasoningContextAllTurns
		default:
			if s != "" {
				return "", nil, &protoErr{field: field + ".context", reason: "unsupported value"}
			}
		}
	}
	flag := ReasoningDefault
	if cfg.Effort != "" || cfg.Enabled || cfg.MaxTokens > 0 || cfg.Mode != "" || cfg.Context != "" {
		flag = ReasoningEnabled
	}
	// Drop empty config so callers can rely on nil == no reasoning.
	if !cfg.Enabled && cfg.Effort == "" && cfg.Summary == "" && cfg.Mode == "" && cfg.Context == "" && cfg.MaxTokens == 0 && !cfg.Exclude {
		cfg = nil
	}
	return flag, cfg, nil
}

// decodeToolChoice normalizes a wire tool_choice literal.
func decodeToolChoice(raw any) (*ToolChoice, error) {
	if raw == nil {
		return nil, nil
	}
	if s, ok := raw.(string); ok {
		switch s {
		case "none", "auto", "required":
			return &ToolChoice{Mode: s}, nil
		}
		return nil, &protoErr{field: "tool_choice", reason: "unsupported tool_choice string"}
	}
	obj, err := asProto("tool_choice", raw)
	if err != nil {
		return nil, err
	}
	if err := boundJSON("tool_choice", obj, MaxTextBlockLength); err != nil {
		return nil, err
	}
	return &ToolChoice{Mode: "object", Object: obj}, nil
}

// encodeToolChoice renders a normalized ToolChoice onto a wire payload.
func encodeToolChoice(tc *ToolChoice) any {
	if tc == nil {
		return nil
	}
	if tc.Object != nil {
		return cloneMap(tc.Object)
	}
	return tc.Mode
}

// decodeResponseFormat normalizes a wire response_format / text.format
// literal. The schema payload, if present, is preserved for json_schema.
func decodeResponseFormat(raw any) (ResponseFormat, map[string]any, error) {
	if raw == nil {
		return FormatText, nil, nil
	}
	obj, err := asProto("response_format", raw)
	if err != nil {
		return "", nil, err
	}
	t, _ := obj["type"].(string)
	switch t {
	case "text", "":
		return FormatText, nil, nil
	case "json_object":
		return FormatJSONObject, nil, nil
	case "json_schema":
		schema, _ := asProto("response_format.json_schema", obj["json_schema"])
		if err := boundJSON("response_format.json_schema", schema, MaxTextBlockLength); err != nil {
			return "", nil, err
		}
		if nested, ok := schema["schema"].(map[string]any); ok {
			schema = nested
		}
		return FormatJSONSchema, schema, nil
	default:
		return "", nil, &protoErr{field: "response_format.type", reason: "unsupported format"}
	}
}

// decodeImageURL handles either {url: ...} objects or bare URL strings.
func decodeImageURL(raw any, field string, images *[]ImageReference) (ImageReference, error) {
	url := raw
	detail := ImageDetail("")
	if obj, ok := raw.(map[string]any); ok {
		url = obj["url"]
		if value, ok := obj["detail"].(string); ok {
			switch value {
			case string(ImageDetailAuto), string(ImageDetailLow), string(ImageDetailHigh), string(ImageDetailOriginal):
				detail = ImageDetail(value)
			default:
				return ImageReference{}, &protoErr{field: field + ".detail", reason: "unsupported image detail"}
			}
		}
	}
	s, err := asString(field+".url", url)
	if err != nil {
		return ImageReference{}, err
	}
	ref := classifyImageReference(s)
	ref.Detail = detail
	*images = append(*images, ref)
	return ref, nil
}

// classifyImageReference mirrors the open-sse classifyImageReference
// helper: url = http(s) or data URL, file = opaque handle.
func classifyImageReference(s string) ImageReference {
	if len(s) >= 5 && s[:5] == "data:" {
		comma := -1
		for i := 5; i < len(s); i++ {
			if s[i] == ',' {
				comma = i
				break
			}
		}
		if comma == -1 {
			return ImageReference{Kind: ImageData, Value: s, MediaType: "image/png"}
		}
		meta := s[5:comma]
		data := s[comma+1:]
		mediaType := "image/png"
		if idx := indexByte(meta, ';'); idx >= 0 {
			mediaType = meta[:idx]
		} else {
			mediaType = meta
		}
		return ImageReference{Kind: ImageData, Value: data, MediaType: mediaType}
	}
	if len(s) >= 7 && s[:7] == "file://" {
		return ImageReference{Kind: ImageFile, Value: s}
	}
	return ImageReference{Kind: ImageURL, Value: s}
}

func indexByte(s string, b byte) int {
	for i := range s {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// openAIImageURL renders a normalized image as an OpenAI-compatible URL.
// File-kind references cannot be inlined and are returned as "" so the
// caller can decide how to handle the gap.
func openAIImageURL(img *ImageReference) string {
	if img == nil {
		return ""
	}
	switch img.Kind {
	case ImageURL:
		return img.Value
	case ImageData:
		if len(img.Value) >= 5 && img.Value[:5] == "data:" {
			return img.Value
		}
		mt := img.MediaType
		if mt == "" {
			mt = "image/png"
		}
		return "data:" + mt + ";base64," + img.Value
	default:
		return ""
	}
}

func openAIImageContent(img *ImageReference) map[string]any {
	content := map[string]any{"url": openAIImageURL(img)}
	if img != nil && img.Detail != "" {
		content["detail"] = string(img.Detail)
	}
	return content
}

func openAIInputImage(img *ImageReference) map[string]any {
	part := map[string]any{"type": "input_image", "image_url": openAIImageURL(img)}
	if img != nil && img.Detail != "" {
		part["detail"] = string(img.Detail)
	}
	return part
}

// applyPassthroughBucket carries unrecognised request metadata into the
// wire payload under a `passthrough` extension bucket so the upstream can
// still observe the client's intent. The function is intentionally
// conservative: it never drops fields the encoder did not explicitly
// route.
func applyPassthroughBucket(payload map[string]any, req *NormalizedRequest, _ string) {
	if req == nil {
		return
	}
	if req.TrailingReasoningItems != nil {
		// Responses-only trailing items must not bleed into chat payloads.
	}
	if req.ContextManagement != nil {
		// Anthropic-only, but passthrough so chat upstreams see the
		// extension rather than a silent drop.
		if _, ok := payload["passthrough"]; !ok {
			payload["passthrough"] = map[string]any{}
		}
		value, err := req.ContextManagement.WireValue()
		if err == nil {
			payload["passthrough"].(map[string]any)["context_management"] = value
		}
	}
	if req.Include != nil {
		if _, ok := payload["passthrough"]; !ok {
			payload["passthrough"] = map[string]any{}
		}
		payload["passthrough"].(map[string]any)["include"] = append([]string(nil), req.Include...)
	}
	if len(req.MCPServers) > 0 {
		if _, ok := payload["passthrough"]; !ok {
			payload["passthrough"] = map[string]any{}
		}
		payload["passthrough"].(map[string]any)["mcp_servers"] = cloneMapList(req.MCPServers)
	}
}

// mergeMap returns a new map containing every key from b overriding any
// value already present in a. The input maps are not mutated.
func mergeMap(a, b map[string]any) map[string]any {
	out := make(map[string]any, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}
