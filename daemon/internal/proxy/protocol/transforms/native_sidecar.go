package transforms

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/jsonclone"
)

// Native sidecars deliberately remain small. They carry provider/client-native
// fields that the canonical model does not own; semantic common fields belong
// in the typed request model instead.
const (
	MaxNativeSidecarBytes        = 64 * 1024
	MaxNativeSidecarFields       = 256
	MaxNativeSidecarFieldBytes   = 16 * 1024
	MaxNativeSidecarPointerDepth = 32
	MaxNativeSidecarPointerBytes = 2048
)

// NativeFieldClass describes the ownership of an opaque field.
type NativeFieldClass string

const (
	NativeFieldSameSurface NativeFieldClass = "same-surface-roundtrip"
	NativeFieldProvider    NativeFieldClass = "provider-native"
	NativeFieldClient      NativeFieldClass = "client-dialect"
	NativeFieldTransport   NativeFieldClass = "transport-only"
	NativeFieldUnknown     NativeFieldClass = "unknown"
)

// JSONPointer is an RFC 6901 pointer. The empty pointer (the JSON document
// root) is intentionally not accepted for sidecar fields.
type JSONPointer string

// NativeField is one bounded opaque JSON value at an exact wire path.
type NativeField struct {
	Path  JSONPointer
	Value json.RawMessage
	Class NativeFieldClass
}

// NativeSidecar retains opaque fields from one source protocol. Capture uses
// stable lexical traversal order and duplicate paths are invalid.
type NativeSidecar struct {
	Source contracts.Protocol
	Fields []NativeField
	Bytes  int
}

// NewNativeSidecar creates an empty sidecar for a source surface.
func NewNativeSidecar(source contracts.Protocol) NativeSidecar {
	return NativeSidecar{Source: source}
}

// Add appends one field after validating all path, JSON, and memory bounds.
func (s *NativeSidecar) Add(path JSONPointer, value json.RawMessage, class NativeFieldClass) *TransformError {
	if s == nil {
		return nativeSidecarError(CodeNativeSidecar, "sidecar", "sidecar is nil")
	}
	if !s.Source.IsValid() {
		return nativeSidecarError(CodeNativeSidecar, "source", "source surface is invalid")
	}
	_, err := parseJSONPointer(path)
	if err != nil {
		return nativeSidecarError(CodeNativeSidecarPath, string(path), err.Error())
	}
	if len(s.Fields) >= MaxNativeSidecarFields {
		return nativeSidecarError(CodeNativeSidecarLimit, string(path), "field count exceeds sidecar limit")
	}
	if len(value) == 0 || len(value) > MaxNativeSidecarFieldBytes || !json.Valid(value) {
		return nativeSidecarError(CodeNativeSidecarLimit, string(path), "field value is invalid or exceeds sidecar limit")
	}
	if class == "" {
		class = NativeFieldUnknown
	}
	if !validNativeFieldClass(class) {
		return nativeSidecarError(CodeNativeSidecar, string(path), "field class is invalid")
	}
	for _, existing := range s.Fields {
		if existing.Path == path {
			return nativeSidecarError(CodeNativeSidecarDuplicate, string(path), "duplicate sidecar path")
		}
	}
	if s.Bytes+len(value)+len(path) > MaxNativeSidecarBytes {
		return nativeSidecarError(CodeNativeSidecarLimit, string(path), "sidecar bytes exceed limit")
	}
	copyValue := append(json.RawMessage(nil), value...)
	s.Fields = append(s.Fields, NativeField{Path: path, Value: copyValue, Class: class})
	s.Bytes += len(copyValue) + len(path)
	return nil
}

// Validate checks a sidecar assembled by a caller or decoder.
func (s NativeSidecar) Validate() *TransformError {
	if !s.Source.IsValid() {
		return nativeSidecarError(CodeNativeSidecar, "source", "source surface is invalid")
	}
	if len(s.Fields) > MaxNativeSidecarFields || s.Bytes < 0 || s.Bytes > MaxNativeSidecarBytes {
		return nativeSidecarError(CodeNativeSidecarLimit, "sidecar", "sidecar bounds exceeded")
	}
	bytesUsed := 0
	for i, field := range s.Fields {
		if _, err := parseJSONPointer(field.Path); err != nil {
			return nativeSidecarError(CodeNativeSidecarPath, string(field.Path), "invalid sidecar pointer")
		}
		if len(field.Value) == 0 || len(field.Value) > MaxNativeSidecarFieldBytes || !json.Valid(field.Value) {
			return nativeSidecarError(CodeNativeSidecarLimit, fmt.Sprintf("fields[%d]", i), "invalid sidecar JSON value")
		}
		if !validNativeFieldClass(field.Class) {
			return nativeSidecarError(CodeNativeSidecar, string(field.Path), "field class is invalid")
		}
		for j := 0; j < i; j++ {
			if s.Fields[j].Path == field.Path {
				return nativeSidecarError(CodeNativeSidecarDuplicate, string(field.Path), "duplicate sidecar path")
			}
		}
		bytesUsed += len(field.Value) + len(field.Path)
	}
	if bytesUsed != s.Bytes {
		return nativeSidecarError(CodeNativeSidecarLimit, "sidecar.bytes", "sidecar byte count is inconsistent")
	}
	return nil
}

// Clone returns a defensive copy suitable for a prepared request.
func (s NativeSidecar) Clone() NativeSidecar {
	out := NativeSidecar{Source: s.Source, Bytes: s.Bytes}
	if len(s.Fields) == 0 {
		return out
	}
	out.Fields = make([]NativeField, len(s.Fields))
	for i, field := range s.Fields {
		out.Fields[i] = NativeField{Path: field.Path, Class: field.Class, Value: append(json.RawMessage(nil), field.Value...)}
	}
	return out
}

// ApplySameSurface reapplies exact source paths only when target and source
// surfaces are identical. It never recursively merges by key name.
func (s NativeSidecar) ApplySameSurface(target contracts.Protocol, encoded map[string]any) (map[string]any, *TransformError) {
	if target != s.Source {
		return nil, nativeSidecarError(CodeNativeSidecarUnconsumed, "surface", "cross-surface sidecar requires an explicit mapping")
	}
	return s.apply(encoded, nil)
}

// ApplyMapped applies an explicit source-pointer to target-pointer mapping for
// a cross-surface projection. Every sidecar field must be mapped; no unknown
// field is silently dropped or copied by global key name.
func (s NativeSidecar) ApplyMapped(target contracts.Protocol, encoded map[string]any, mappings map[JSONPointer]JSONPointer) (map[string]any, *TransformError) {
	if target == s.Source {
		return s.ApplySameSurface(target, encoded)
	}
	if !target.IsValid() {
		return nil, nativeSidecarError(CodeNativeSidecarUnconsumed, "surface", "target surface is invalid")
	}
	return s.apply(encoded, mappings)
}

func (s NativeSidecar) apply(encoded map[string]any, mappings map[JSONPointer]JSONPointer) (map[string]any, *TransformError) {
	if err := s.Validate(); err != nil {
		return nil, err
	}
	if encoded == nil {
		return nil, nativeSidecarError(CodeNativeSidecar, "encoded", "encoded body is nil")
	}
	root := jsonclone.CloneValue(encoded).(map[string]any)
	for _, field := range s.Fields {
		if field.Class == NativeFieldTransport {
			continue
		}
		if mappings != nil && field.Class == NativeFieldSameSurface {
			return nil, nativeSidecarError(CodeNativeSidecarUnconsumed, string(field.Path), "same-surface field cannot cross surfaces")
		}
		targetPath := field.Path
		if mappings != nil {
			mapped, ok := mappings[field.Path]
			if !ok {
				return nil, nativeSidecarError(CodeNativeSidecarUnconsumed, string(field.Path), "sidecar field has no explicit target mapping")
			}
			targetPath = mapped
		}
		segments, pathErr := parseJSONPointer(targetPath)
		if pathErr != nil {
			return nil, nativeSidecarError(CodeNativeSidecarPath, string(targetPath), "mapped target pointer is invalid")
		}
		var value any
		if err := json.Unmarshal(field.Value, &value); err != nil {
			return nil, nativeSidecarError(CodeNativeSidecar, string(field.Path), "sidecar value cannot be decoded")
		}
		if err := setJSONPath(root, segments, value); err != nil {
			return nil, nativeSidecarError(CodeNativeSidecarUnconsumed, string(field.Path), err.Error())
		}
	}
	return root, nil
}

// CaptureNativeSidecar compares the original source tree with the canonical
// wire tree and records only absent extension fields at exact paths. Arrays
// are traversed by original index only when cardinality is unchanged.
func CaptureNativeSidecar(source contracts.Protocol, original []byte, encoded map[string]any) (NativeSidecar, *TransformError) {
	sidecar := NewNativeSidecar(source)
	if !source.IsValid() {
		return sidecar, nativeSidecarError(CodeNativeSidecar, "source", "source surface is invalid")
	}
	if encoded == nil {
		return sidecar, nativeSidecarError(CodeNativeSidecar, "encoded", "encoded body is nil")
	}
	if len(original) == 0 {
		return sidecar, nil
	}
	if err := rejectDuplicateJSONKeys(original); err != nil {
		return sidecar, nativeSidecarError(CodeNativeSidecar, "body", err.Error())
	}
	var raw any
	dec := json.NewDecoder(bytes.NewReader(original))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return sidecar, nativeSidecarError(CodeNativeSidecar, "body", "source body is invalid JSON")
	}
	var trailing any
	if err := dec.Decode(&trailing); err == nil {
		return sidecar, nativeSidecarError(CodeNativeSidecar, "body", "source body has trailing JSON")
	}
	if _, ok := raw.(map[string]any); !ok {
		return sidecar, nativeSidecarError(CodeNativeSidecar, "body", "source body must be a JSON object")
	}
	encodedBytes, err := json.Marshal(encoded)
	if err != nil {
		return sidecar, nativeSidecarError(CodeNativeSidecar, "encoded", "encoded body cannot be marshaled")
	}
	var encodedTree any
	if err := json.Unmarshal(encodedBytes, &encodedTree); err != nil {
		return sidecar, nativeSidecarError(CodeNativeSidecar, "encoded", "encoded body cannot be decoded")
	}
	if err := captureNativeValue(&sidecar, source, "", raw, encodedTree); err != nil {
		return sidecar, err
	}
	return sidecar, nil
}

func captureNativeValue(sidecar *NativeSidecar, source contracts.Protocol, path string, original, encoded any) *TransformError {
	om, omOK := original.(map[string]any)
	em, emOK := encoded.(map[string]any)
	if omOK {
		if !emOK {
			return nil
		}
		keys := make([]string, 0, len(om))
		for key := range om {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			value := om[key]
			childPath := appendJSONPointer(path, key)
			encodedValue, exists := em[key]
			if !exists {
				if path == "" && canonicalSourceRootKey(source, key) {
					continue
				}
				raw, err := json.Marshal(value)
				if err != nil {
					return nativeSidecarError(CodeNativeSidecar, childPath, "extension value cannot be encoded")
				}
				if err := sidecar.Add(JSONPointer(childPath), raw, NativeFieldUnknown); err != nil {
					return err
				}
				continue
			}
			if err := captureNativeValue(sidecar, source, childPath, value, encodedValue); err != nil {
				return err
			}
		}
		return nil
	}
	if oa, ok := original.([]any); ok {
		ea, encodedArray := encoded.([]any)
		if !encodedArray {
			return nil
		}
		if len(oa) != len(ea) {
			if arrayHasExtensions(oa) {
				return nativeSidecarError(CodeNativeSidecarUnconsumed, path, "array cardinality changed while extension fields are present")
			}
			return nil
		}
		if arrayHasExtensions(oa) {
			for i := range oa {
				originalIdentity := nativeArrayIdentity(oa[i])
				encodedIdentity := nativeArrayIdentity(ea[i])
				if originalIdentity != "" && encodedIdentity != "" && originalIdentity != encodedIdentity {
					return nativeSidecarError(CodeNativeSidecarUnconsumed, path, "array identity/order changed while extension fields are present")
				}
			}
		}
		for i := range oa {
			if err := captureNativeValue(sidecar, source, appendJSONPointer(path, fmt.Sprintf("%d", i)), oa[i], ea[i]); err != nil {
				return err
			}
		}
	}
	return nil
}

func arrayHasExtensions(values []any) bool {
	for _, value := range values {
		if object, ok := value.(map[string]any); ok {
			for key, nested := range object {
				if !canonicalArrayKey(key) {
					return true
				}
				if child, ok := nested.([]any); ok && arrayHasExtensions(child) {
					return true
				}
			}
		}
	}
	return false
}

func canonicalArrayKey(key string) bool {
	switch key {
	case "role", "content", "type", "text", "name", "id", "index", "phase", "status", "call_id", "arguments", "output", "function", "tool_calls", "tool_call_id", "input", "image_url", "source", "url", "data", "media_type", "detail", "summary", "encrypted_content", "annotations", "refusal", "cache_read_input_tokens", "cache_creation_input_tokens":
		return true
	default:
		return false
	}
}

func nativeArrayIdentity(value any) string {
	object, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	for _, key := range []string{"id", "call_id", "tool_call_id", "name"} {
		if identity, ok := object[key].(string); ok && identity != "" {
			return key + "=" + identity
		}
	}
	return ""
}

func canonicalSourceRootKey(source contracts.Protocol, key string) bool {
	switch source {
	case contracts.ProtocolOpenAIChat:
		switch key {
		case "model", "stream", "messages", "tools", "tool_choice", "response_format", "max_tokens", "max_completion_tokens", "max_output_tokens", "temperature", "top_p", "stop", "parallel_tool_calls", "metadata", "prompt_cache_key", "reasoning", "user", "n", "modalities", "audio", "prediction", "service_tier", "safety_identifier":
			return true
		}
	case contracts.ProtocolOpenAIResponse:
		switch key {
		case "model", "stream", "input", "instructions", "tools", "tool_choice", "text", "max_output_tokens", "temperature", "top_p", "parallel_tool_calls", "metadata", "prompt_cache_key", "reasoning", "include", "context_management", "store", "previous_response_id", "service_tier":
			return true
		}
	case contracts.ProtocolAnthropic:
		switch key {
		case "model", "stream", "messages", "system", "tools", "tool_choice", "max_tokens", "temperature", "top_p", "top_k", "stop_sequences", "metadata", "reasoning", "context_management":
			return true
		}
	case contracts.ProtocolGemini:
		switch key {
		case "model", "model_name", "contents", "systemInstruction", "generationConfig", "toolConfig", "tools", "cachedContent", "metadata":
			return true
		}
	}
	return false
}

func appendJSONPointer(parent, segment string) string {
	escaped := strings.ReplaceAll(strings.ReplaceAll(segment, "~", "~0"), "/", "~1")
	return parent + "/" + escaped
}

func parseJSONPointer(pointer JSONPointer) ([]string, error) {
	value := string(pointer)
	if value == "" || len(value) > MaxNativeSidecarPointerBytes || !strings.HasPrefix(value, "/") {
		return nil, fmt.Errorf("pointer must be a non-root path beginning with '/'")
	}
	raw := strings.Split(value[1:], "/")
	if len(raw) > MaxNativeSidecarPointerDepth {
		return nil, fmt.Errorf("pointer depth exceeds limit")
	}
	segments := make([]string, len(raw))
	for i, segment := range raw {
		var b strings.Builder
		for j := 0; j < len(segment); j++ {
			switch segment[j] {
			case '~':
				if j+1 >= len(segment) || (segment[j+1] != '0' && segment[j+1] != '1') {
					return nil, fmt.Errorf("pointer contains invalid escape")
				}
				if segment[j+1] == '0' {
					b.WriteByte('~')
				} else {
					b.WriteByte('/')
				}
				j++
			default:
				b.WriteByte(segment[j])
			}
		}
		segments[i] = b.String()
		for _, character := range segments[i] {
			if character < 0x20 {
				return nil, fmt.Errorf("pointer contains a control character")
			}
		}
	}
	return segments, nil
}

func setJSONPath(root map[string]any, segments []string, value any) error {
	if len(segments) == 0 {
		return fmt.Errorf("root pointer is not assignable")
	}
	var current any = root
	for i, segment := range segments {
		last := i == len(segments)-1
		switch object := current.(type) {
		case map[string]any:
			if last {
				object[segment] = value
				return nil
			}
			next, ok := object[segment]
			if !ok {
				return fmt.Errorf("target path does not exist")
			}
			current = next
		case []any:
			index, err := parseArrayIndex(segment, len(object))
			if err != nil {
				return err
			}
			if last {
				object[index] = value
				return nil
			}
			current = object[index]
		default:
			return fmt.Errorf("target path crosses a scalar")
		}
	}
	return fmt.Errorf("target path is not assignable")
}

func parseArrayIndex(segment string, length int) (int, error) {
	if segment == "" || (len(segment) > 1 && segment[0] == '0') {
		return 0, fmt.Errorf("array pointer index is invalid")
	}
	index := 0
	for i := 0; i < len(segment); i++ {
		if segment[i] < '0' || segment[i] > '9' {
			return 0, fmt.Errorf("array pointer index is invalid")
		}
		if index > (length-1)/10 {
			return 0, fmt.Errorf("array pointer index is out of range")
		}
		index = index*10 + int(segment[i]-'0')
		if index >= length {
			return 0, fmt.Errorf("array pointer index is out of range")
		}
	}
	return index, nil
}

func nativeSidecarError(code TransformErrorCode, field, reason string) *TransformError {
	return newTransformError(code, "native-sidecar", "", field, reason, nil)
}

func validNativeFieldClass(class NativeFieldClass) bool {
	switch class {
	case NativeFieldSameSurface, NativeFieldProvider, NativeFieldClient, NativeFieldTransport, NativeFieldUnknown:
		return true
	default:
		return false
	}
}

// rejectDuplicateJSONKeys validates object keys before json.Unmarshal loses
// duplicate-key information. This protects exact-path capture from ambiguous
// source paths.
func rejectDuplicateJSONKeys(body []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	var readValue func() error
	readValue = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		if delimiter, ok := token.(json.Delim); ok {
			switch delimiter {
			case '{':
				seen := make(map[string]struct{})
				for decoder.More() {
					keyToken, err := decoder.Token()
					if err != nil {
						return err
					}
					key, ok := keyToken.(string)
					if !ok {
						return fmt.Errorf("object key is invalid")
					}
					if _, exists := seen[key]; exists {
						return fmt.Errorf("duplicate object key")
					}
					seen[key] = struct{}{}
					if err := readValue(); err != nil {
						return err
					}
				}
				_, err = decoder.Token()
				return err
			case '[':
				for decoder.More() {
					if err := readValue(); err != nil {
						return err
					}
				}
				_, err = decoder.Token()
				return err
			}
		}
		return nil
	}
	if err := readValue(); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return fmt.Errorf("trailing JSON value")
	} else if err != io.EOF {
		return err
	}
	return nil
}
