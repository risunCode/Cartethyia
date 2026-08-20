package codec

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// ToolArgumentLimit mirrors the legacy MAX_TOOL_ARGUMENT_LENGTH bound (64 KiB).
const ToolArgumentLimit = 64 * 1024

// StringifyToolArguments converts a tool arguments value into the JSON
// string form that the OpenAI wire surfaces expect. Object inputs are
// re-serialized (preserving key order via encoding/json's deterministic
// map ordering); scalar inputs are coerced through JSON.
func StringifyToolArguments(raw any) (string, error) {
	if raw == nil {
		return "{}", nil
	}
	switch v := raw.(type) {
	case string:
		if len(v) > ToolArgumentLimit {
			return "", fmt.Errorf("tool arguments exceed %d bytes", ToolArgumentLimit)
		}
		return v, nil
	default:
		buf, err := json.Marshal(v)
		if err != nil {
			return "", fmt.Errorf("encode tool arguments: %w", err)
		}
		if len(buf) > ToolArgumentLimit {
			return "", fmt.Errorf("tool arguments exceed %d bytes", ToolArgumentLimit)
		}
		return string(buf), nil
	}
}

// RepairToolCallArguments normalizes a tool-call argument string in place.
// The repair pipeline:
//
//  1. Strip surrounding whitespace.
//  2. If empty, return "{}".
//  3. If the value parses as JSON, return it normalized (compact form).
//  4. Otherwise return the value untouched so downstream providers can
//     observe the original client intent.
//
// This intentionally never drops a payload field; if a caller wants to
// reject malformed arguments, they should do so at decode time.
func RepairToolCallArguments(raw string) string {
	if len(raw) == 0 {
		return "{}"
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var probe any
	if err := decoder.Decode(&probe); err == nil {
		var extra any
		if trailingErr := decoder.Decode(&extra); trailingErr != io.EOF {
			return raw
		}
		// Normalize through Marshal to drop insignificant whitespace.
		buf, err := json.Marshal(probe)
		if err == nil {
			return string(buf)
		}
	}
	return raw
}

// NormalizedToolCallFromMap converts a raw function-call map into a
// NormalizedToolCall, applying the same id fallback the open-sse codecs
// use (`call_<name>`) when the wire body omits the call id.
func NormalizedToolCallFromMap(raw map[string]any) NormalizedToolCall {
	id, _ := raw["id"].(string)
	if id == "" {
		if name, _ := raw["name"].(string); name != "" {
			id = "call_" + name
		} else {
			id = "call_unknown"
		}
	}
	name, _ := raw["name"].(string)
	args, err := StringifyToolArguments(raw["arguments"])
	if err != nil {
		// Preserve original behaviour: keep whatever the caller had.
		if s, ok := raw["arguments"].(string); ok {
			args = s
		} else {
			args = "{}"
		}
	}
	return NormalizedToolCall{ID: id, Name: name, Arguments: RepairToolCallArguments(args)}
}
