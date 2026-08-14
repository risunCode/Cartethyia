package transforms

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// MaxTextBlockLength matches the open-sse MAX_TEXT_BLOCK_LENGTH bound
// (32 KiB) used to cap user-visible text in normalized content blocks.
const MaxTextBlockLength = 32 * 1024

// MaxModelLength matches MAX_MODEL_LENGTH.
const MaxModelLength = 256

// MaxMessageCount matches MAX_MESSAGE_COUNT.
const MaxMessageCount = 4096

// MaxBlocksPerMessage matches MAX_BLOCKS_PER_MESSAGE.
const MaxBlocksPerMessage = 4096

// MaxToolCallsPerMessage matches MAX_TOOL_CALLS_PER_MESSAGE.
const MaxToolCallsPerMessage = 64

// MaxToolNameLength bounds canonical tool names.
const MaxToolNameLength = 128

// MaxToolCount bounds canonical tool declarations.
const MaxToolCount = 128

// MaxImageCount bounds canonical image references.
const MaxImageCount = 128

// MaxStopCount bounds stop sequences carried by one request.
const MaxStopCount = 64

// MaxNativePayloadBytes bounds provider-native opaque JSON and tool arguments.
const MaxNativePayloadBytes = 64 * 1024

// MaxToolArgumentBytes bounds JSON-encoded tool-call arguments.
const MaxToolArgumentBytes = 64 * 1024

// MaxOutputTokens matches MAX_OUTPUT_TOKENS.
const MaxOutputTokens = 1 << 20

// protoErr is the internal error type returned by the narrow* helpers. It
// stays unexported because callers should rely on TransformError.
type protoErr struct {
	field  string
	reason string
}

func (e *protoErr) Error() string { return e.field + ": " + e.reason }

// isProtoErr is used by every narrow* helper to short-circuit at the first
// validation failure.
func isProtoErr(err error) (*protoErr, bool) {
	if err == nil {
		return nil, false
	}
	pe, ok := err.(*protoErr)
	return pe, ok
}

// Validate enforces semantic and bounded invariants after a surface decoder
// has projected wire fields into the canonical normalized request.
func (r *NormalizedRequest) Validate() error {
	if r == nil {
		return &protoErr{field: "request", reason: "request must not be nil"}
	}
	if r.Model == "" {
		return &protoErr{field: "model", reason: "model is required"}
	}
	if err := boundedValue("model", r.Model, MaxModelLength, true); err != nil {
		return err
	}
	if !r.Source.IsValid() {
		return &protoErr{field: "surface", reason: "unsupported canonical surface"}
	}
	if len(r.Messages) > MaxMessageCount {
		return &protoErr{field: "messages", reason: "too many messages"}
	}
	if len(r.Tools) > MaxToolCount {
		return &protoErr{field: "tools", reason: "too many tools"}
	}
	if len(r.Images) > MaxImageCount {
		return &protoErr{field: "images", reason: "too many images"}
	}
	if len(r.Stop) > MaxStopCount {
		return &protoErr{field: "stop", reason: "too many stop sequences"}
	}
	for i, message := range r.Messages {
		if err := validateNormalizedMessage(message, fmt.Sprintf("messages[%d]", i)); err != nil {
			return err
		}
	}
	for i, tool := range r.Tools {
		if err := validateNormalizedTool(tool, fmt.Sprintf("tools[%d]", i)); err != nil {
			return err
		}
	}
	for i, image := range r.Images {
		if err := validateImageReference(image, fmt.Sprintf("images[%d]", i)); err != nil {
			return err
		}
	}
	if r.ToolChoice != nil {
		if err := boundedValue("tool_choice.mode", r.ToolChoice.Mode, MaxModelLength, false); err != nil {
			return err
		}
		if err := boundedMap("tool_choice", r.ToolChoice.Object); err != nil {
			return err
		}
	}
	if err := boundedMap("response_format_schema", r.ResponseFormatSchema); err != nil {
		return err
	}
	switch r.ResponseFormat {
	case "", FormatText, FormatJSONObject, FormatJSONSchema:
	default:
		return &protoErr{field: "response_format", reason: "unsupported response format"}
	}
	if r.MaxOutputTokens != nil && (*r.MaxOutputTokens < 1 || *r.MaxOutputTokens > MaxOutputTokens) {
		return &protoErr{field: "max_output_tokens", reason: "value out of range"}
	}
	if r.Temperature != nil && (math.IsNaN(*r.Temperature) || math.IsInf(*r.Temperature, 0) || *r.Temperature < 0 || *r.Temperature > 2) {
		return &protoErr{field: "temperature", reason: "value out of range"}
	}
	if r.TopP != nil && (math.IsNaN(*r.TopP) || math.IsInf(*r.TopP, 0) || *r.TopP < 0 || *r.TopP > 1) {
		return &protoErr{field: "top_p", reason: "value out of range"}
	}
	for i, stop := range r.Stop {
		if err := boundedValue(fmt.Sprintf("stop[%d]", i), stop, MaxTextBlockLength, false); err != nil {
			return err
		}
	}
	if err := validateReasoning(r.Reasoning, r.ReasoningConfig); err != nil {
		return err
	}
	if err := boundedValue("cache_key", r.CacheKey, MaxModelLength, false); err != nil {
		return err
	}
	for i, include := range r.Include {
		if err := boundedValue(fmt.Sprintf("include[%d]", i), include, MaxModelLength, true); err != nil {
			return err
		}
	}
	if err := boundedMapOrArray("context_management", r.ContextManagement); err != nil {
		return err
	}
	if len(r.MCPServers) > MaxToolCount {
		return &protoErr{field: "mcp_servers", reason: "too many servers"}
	}
	for i, item := range r.MCPServers {
		if err := boundedMap(fmt.Sprintf("mcp_servers[%d]", i), item); err != nil {
			return err
		}
	}
	for i, item := range r.TrailingReasoningItems {
		if err := boundedMap(fmt.Sprintf("trailing_reasoning_items[%d]", i), item); err != nil {
			return err
		}
	}
	if err := boundedMap("metadata", r.Metadata); err != nil {
		return err
	}
	return nil
}

func validateNormalizedMessage(message NormalizedMessage, field string) error {
	switch message.Role {
	case RoleSystem, RoleDeveloper, RoleUser, RoleAssistant, RoleTool:
	default:
		return &protoErr{field: field + ".role", reason: "unsupported role"}
	}
	if err := boundedValue(field+".reasoning_content", message.ReasoningContent, MaxTextBlockLength, false); err != nil {
		return err
	}
	switch message.Phase {
	case "", "commentary", "final_answer":
	default:
		return &protoErr{field: field + ".phase", reason: "unsupported phase"}
	}
	if len(message.Content) > MaxBlocksPerMessage {
		return &protoErr{field: field + ".content", reason: "too many content blocks"}
	}
	for i, block := range message.Content {
		if err := validateContentBlock(block, fmt.Sprintf("%s.content[%d]", field, i)); err != nil {
			return err
		}
	}
	for i, item := range message.ReasoningItemsBefore {
		if err := boundedMap(fmt.Sprintf("%s.reasoning_items_before[%d]", field, i), item); err != nil {
			return err
		}
	}
	return nil
}

func validateContentBlock(block ContentBlock, field string) error {
	switch block.Type {
	case BlockText, BlockImage, BlockToolUse, BlockToolResult, BlockReasoning,
		BlockCompaction, BlockNative, BlockUnknown:
	default:
		return &protoErr{field: field + ".type", reason: "unsupported content block"}
	}
	if err := boundedValue(field+".text", block.Text, MaxTextBlockLength, false); err != nil {
		return err
	}
	if err := boundedValue(field+".tool_name", block.ToolName, MaxToolNameLength, false); err != nil {
		return err
	}
	if err := boundedValue(field+".tool_call_id", block.ToolCallID, MaxModelLength, false); err != nil {
		return err
	}
	if len(block.ToolArguments) > MaxToolArgumentBytes {
		return &protoErr{field: field + ".tool_arguments", reason: "arguments exceed bound"}
	}
	if block.ToolArguments != "" && !json.Valid([]byte(block.ToolArguments)) {
		return &protoErr{field: field + ".tool_arguments", reason: "arguments must be valid JSON"}
	}
	if err := boundedValue(field+".reasoning_text", block.ReasoningText, MaxTextBlockLength, false); err != nil {
		return err
	}
	if err := boundedValue(field+".reasoning_signature", block.ReasoningSignature, MaxNativePayloadBytes, false); err != nil {
		return err
	}
	if err := boundedValue(field+".reasoning_encrypted_content", block.ReasoningEncryptedContent, MaxNativePayloadBytes, false); err != nil {
		return err
	}
	if err := boundedMapArray(field+".reasoning_summary", block.ReasoningSummary); err != nil {
		return err
	}
	if err := boundedMap(field+".native_payload", block.NativePayload); err != nil {
		return err
	}
	if err := boundedMap(field+".raw", block.Raw); err != nil {
		return err
	}
	if block.Type == BlockImage && block.Image == nil {
		return &protoErr{field: field + ".image", reason: "image block is missing image"}
	}
	if block.Image != nil {
		if err := validateImageReference(*block.Image, field+".image"); err != nil {
			return err
		}
	}
	if block.Type == BlockToolUse && block.ToolName == "" {
		return &protoErr{field: field + ".tool_name", reason: "tool-use block requires a tool name"}
	}
	if block.Type == BlockNative && block.NativeType == "" && len(block.NativePayload) == 0 {
		return &protoErr{field: field + ".native", reason: "native block is missing payload"}
	}
	return nil
}

func validateNormalizedTool(tool Tool, field string) error {
	if err := boundedValue(field+".name", tool.Name, MaxToolNameLength, true); err != nil {
		return err
	}
	if err := boundedValue(field+".description", tool.Description, MaxTextBlockLength, false); err != nil {
		return err
	}
	if err := boundedMap(field+".input_schema", tool.InputSchema); err != nil {
		return err
	}
	if err := boundedValue(field+".native_type", tool.NativeType, MaxModelLength, false); err != nil {
		return err
	}
	if err := boundedMap(field+".native_options", tool.NativeOptions); err != nil {
		return err
	}
	if len(tool.AllowedCallers) > MaxToolCallsPerMessage {
		return &protoErr{field: field + ".allowed_callers", reason: "too many callers"}
	}
	for i, caller := range tool.AllowedCallers {
		if err := boundedValue(fmt.Sprintf("%s.allowed_callers[%d]", field, i), caller, MaxModelLength, true); err != nil {
			return err
		}
	}
	if len(tool.InputExamples) > MaxBlocksPerMessage {
		return &protoErr{field: field + ".input_examples", reason: "too many examples"}
	}
	for i, example := range tool.InputExamples {
		if err := boundedMap(fmt.Sprintf("%s.input_examples[%d]", field, i), example); err != nil {
			return err
		}
	}
	return nil
}

func validateImageReference(image ImageReference, field string) error {
	switch image.Kind {
	case ImageURL, ImageData, ImageFile:
	default:
		return &protoErr{field: field + ".kind", reason: "unsupported image kind"}
	}
	if err := boundedValue(field+".value", image.Value, MaxNativePayloadBytes, true); err != nil {
		return err
	}
	return boundedValue(field+".media_type", image.MediaType, MaxModelLength, false)
}

func validateReasoning(flag ReasoningFlag, cfg *ReasoningConfig) error {
	switch flag {
	case "", ReasoningDefault, ReasoningEnabled, ReasoningDisabled:
	default:
		return &protoErr{field: "reasoning", reason: "unsupported reasoning flag"}
	}
	if cfg == nil {
		return nil
	}
	if err := boundedValue("reasoning.effort", string(cfg.Effort), MaxModelLength, false); err != nil {
		return err
	}
	if err := boundedValue("reasoning.summary", string(cfg.Summary), MaxModelLength, false); err != nil {
		return err
	}
	if err := boundedValue("reasoning.mode", string(cfg.Mode), MaxModelLength, false); err != nil {
		return err
	}
	if err := boundedValue("reasoning.context", string(cfg.Context), MaxModelLength, false); err != nil {
		return err
	}
	if cfg.MaxTokens < 0 || cfg.MaxTokens > MaxOutputTokens {
		return &protoErr{field: "reasoning.max_tokens", reason: "value out of range"}
	}
	return nil
}

func boundedValue(field, value string, max int, required bool) error {
	if required && strings.TrimSpace(value) == "" {
		return &protoErr{field: field, reason: "value is required"}
	}
	if len(value) > max {
		return &protoErr{field: field, reason: "value exceeds bound"}
	}
	return nil
}

func boundedMap(field string, value map[string]any) error {
	if value == nil {
		return nil
	}
	return boundJSON(field, value, MaxNativePayloadBytes)
}

func boundedMapArray(field string, values []map[string]any) error {
	if len(values) > MaxBlocksPerMessage {
		return &protoErr{field: field, reason: "too many objects"}
	}
	for i, value := range values {
		if err := boundedMap(fmt.Sprintf("%s[%d]", field, i), value); err != nil {
			return err
		}
	}
	return nil
}

func boundedMapOrArray(field string, value any) error {
	switch v := value.(type) {
	case nil:
		return nil
	case map[string]any:
		return boundedMap(field, v)
	case []map[string]any:
		return boundedMapArray(field, v)
	default:
		return &protoErr{field: field, reason: "expected an object or object array"}
	}
}

// asProto converts a wire value into a map[string]any. nil / non-object
// values produce a *protoErr tagged with the field name.
func asProto(field string, raw any) (map[string]any, error) {
	switch v := raw.(type) {
	case nil:
		return nil, nil
	case map[string]any:
		return v, nil
	default:
		return nil, &protoErr{field: field, reason: "expected an object"}
	}
}

func asArray(field string, raw any) ([]any, error) {
	switch v := raw.(type) {
	case nil:
		return nil, nil
	case []any:
		return v, nil
	default:
		return nil, &protoErr{field: field, reason: "expected an array"}
	}
}

func asString(field string, raw any) (string, error) {
	switch v := raw.(type) {
	case nil:
		return "", nil
	case string:
		return v, nil
	default:
		return "", &protoErr{field: field, reason: "expected a string"}
	}
}

func asBool(field string, raw any) (bool, error) {
	switch v := raw.(type) {
	case nil:
		return false, nil
	case bool:
		return v, nil
	default:
		return false, &protoErr{field: field, reason: "expected a boolean"}
	}
}

// asInt parses an integer value. Strings that look like integers are
// accepted for compatibility with JSON encoders that widen numbers to
// floats.
func asInt(field string, raw any) (int, error) {
	switch v := raw.(type) {
	case nil:
		return 0, nil
	case json.Number:
		n, err := strconv.Atoi(v.String())
		if err != nil {
			return 0, &protoErr{field: field, reason: "expected an integer"}
		}
		return n, nil
	case float64:
		return int(v), nil
	case int:
		return v, nil
	case int64:
		return int(v), nil
	case string:
		n, err := strconv.Atoi(v)
		if err != nil {
			return 0, &protoErr{field: field, reason: "expected an integer"}
		}
		return n, nil
	default:
		return 0, &protoErr{field: field, reason: "expected an integer"}
	}
}

func asFloat(field string, raw any) (float64, error) {
	switch v := raw.(type) {
	case nil:
		return 0, nil
	case json.Number:
		n, err := strconv.ParseFloat(v.String(), 64)
		if err != nil {
			return 0, &protoErr{field: field, reason: "expected a number"}
		}
		return n, nil
	case float64:
		return v, nil
	case int:
		return float64(v), nil
	default:
		return 0, &protoErr{field: field, reason: "expected a number"}
	}
}

// boundText enforces the per-block text length limit.
func boundText(field, text string) error {
	if len(text) > MaxTextBlockLength {
		return &protoErr{field: field, reason: fmt.Sprintf("text exceeds %d characters", MaxTextBlockLength)}
	}
	return nil
}

// decodeBody decodes a JSON body or returns the first validation error.
func decodeBody(body []byte) (map[string]any, error) {
	if len(body) == 0 {
		return map[string]any{}, nil
	}
	dec := json.NewDecoder(newBytesReader(body))
	dec.UseNumber()
	var root any
	if err := dec.Decode(&root); err != nil {
		return nil, &protoErr{field: "body", reason: "invalid JSON: " + err.Error()}
	}
	obj, err := asProto("body", root)
	if err != nil {
		return nil, err
	}
	return obj, nil
}

// boundJSON checks that the marshaled form of value fits within limit.
func boundJSON(field string, value any, limit int) error {
	buf, err := json.Marshal(value)
	if err != nil {
		return &protoErr{field: field, reason: "value not encodable"}
	}
	if len(buf) > limit {
		return &protoErr{field: field, reason: fmt.Sprintf("exceeds %d characters", limit)}
	}
	return nil
}

// roleFromString maps a wire role literal to a normalized Role.
func roleFromString(field, raw string) (Role, error) {
	switch raw {
	case "system":
		return RoleSystem, nil
	case "developer":
		return RoleDeveloper, nil
	case "user":
		return RoleUser, nil
	case "assistant":
		return RoleAssistant, nil
	case "tool":
		return RoleTool, nil
	default:
		return "", &protoErr{field: field, reason: fmt.Sprintf("unsupported role %q", raw)}
	}
}

// messageText concatenates visible text from a normalized message.
func messageText(m NormalizedMessage) string {
	var out string
	for _, b := range m.Content {
		if b.Type == BlockText {
			if out == "" {
				out = b.Text
			} else {
				out += "\n" + b.Text
			}
		}
	}
	return out
}

// cloneMap shallow-copies a map. Used to avoid leaking caller-owned maps
// into encoder output.
func cloneMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
