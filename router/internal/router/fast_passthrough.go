package router

import (
	"context"
	"encoding/json"
	"fmt"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// IsSameSurface reports whether the source and target protocols are the same
// surface, meaning a same-surface passthrough can avoid full AST reconstruction.
func IsSameSurface(source contracts.Surface, target contracts.Surface) bool {
	return source == target
}

// SameSurfacePreparation is the result of the bounded same-surface request
// preparation step. Body is an owned copy of the input unless a known
// top-level field (currently model) needs a bounded patch.
type SameSurfacePreparation struct {
	Body    []byte
	Model   string
	Mode    contracts.ProcessingMode
	Patched bool
}

const maxSameSurfaceFields = 256

// PrepareSameSurfaceRequest applies only bounded, known-field edits. Requests
// that need no edit take the PASS path and retain the caller's bytes exactly;
// no canonical decoder, encoder, or map representation is involved.
func PrepareSameSurfaceRequest(_ context.Context, surface contracts.Surface, model string, body []byte) (SameSurfacePreparation, error) {
	if !surface.IsValid() {
		return SameSurfacePreparation{}, fmt.Errorf("unsupported same-surface %q", surface)
	}
	if len(body) == 0 || len(body) > contracts.MaxRequestBodyBytes {
		return SameSurfacePreparation{}, fmt.Errorf("request body is invalid")
	}
	if !json.Valid(body) {
		return SameSurfacePreparation{}, fmt.Errorf("failed to parse request body: invalid JSON")
	}
	fields, end, err := scanJSONObject(body)
	if err != nil {
		return SameSurfacePreparation{}, fmt.Errorf("failed to parse request body: %w", err)
	}
	bodyModel, _ := topLevelStringField(body, fields, "model")
	if model == "" {
		model = bodyModel
	}
	if model == "" {
		return SameSurfacePreparation{}, fmt.Errorf("model is required")
	}
	cleanModel, _ := contracts.ParseModelSuffix(model)
	if cleanModel == "" {
		cleanModel = model
	}
	if len(cleanModel) > contracts.MaxIdentifierBytes {
		return SameSurfacePreparation{}, fmt.Errorf("model exceeds maximum length")
	}
	// PASS: a body model that already matches the routed model is forwarded
	// byte-for-byte. PATCH only replaces the known top-level model value.
	if cleanModel == bodyModel {
		return SameSurfacePreparation{Body: append([]byte(nil), body...), Model: cleanModel, Mode: contracts.ModePass}, nil
	}
	patched, err := patchTopLevelStringField(body, fields, end, "model", cleanModel)
	if err != nil {
		return SameSurfacePreparation{}, err
	}
	return SameSurfacePreparation{Body: patched, Model: cleanModel, Mode: contracts.ModePatch, Patched: true}, nil
}

type jsonFieldRange struct {
	key       string
	valueFrom int
	valueTo   int
}

func scanJSONObject(body []byte) ([]jsonFieldRange, int, error) {
	i := skipJSONSpace(body, 0)
	if i >= len(body) || body[i] != '{' {
		return nil, 0, fmt.Errorf("request body must be a JSON object")
	}
	i++
	fields := make([]jsonFieldRange, 0, 8)
	for {
		i = skipJSONSpace(body, i)
		if i >= len(body) {
			return nil, 0, fmt.Errorf("unterminated request object")
		}
		if body[i] == '}' {
			return fields, i, nil
		}
		if body[i] != '"' {
			return nil, 0, fmt.Errorf("object key must be a string")
		}
		keyStart := i
		keyEnd, err := skipJSONString(body, i)
		if err != nil {
			return nil, 0, err
		}
		var key string
		if err := json.Unmarshal(body[keyStart:keyEnd], &key); err != nil {
			return nil, 0, err
		}
		i = skipJSONSpace(body, keyEnd)
		if i >= len(body) || body[i] != ':' {
			return nil, 0, fmt.Errorf("object key %q has no value", key)
		}
		i = skipJSONSpace(body, i+1)
		valueFrom := i
		valueTo, err := skipJSONValue(body, i)
		if err != nil {
			return nil, 0, err
		}
		fields = append(fields, jsonFieldRange{key: key, valueFrom: valueFrom, valueTo: valueTo})
		if len(fields) > maxSameSurfaceFields {
			return nil, 0, fmt.Errorf("request object has too many fields")
		}
		i = skipJSONSpace(body, valueTo)
		if i >= len(body) {
			return nil, 0, fmt.Errorf("unterminated request object")
		}
		if body[i] == ',' {
			i++
			continue
		}
		if body[i] != '}' {
			return nil, 0, fmt.Errorf("object value must be followed by comma or close")
		}
		return fields, i, nil
	}
}

func topLevelStringField(body []byte, fields []jsonFieldRange, key string) (string, bool) {
	for _, field := range fields {
		if field.key != key || field.valueFrom >= field.valueTo || body[field.valueFrom] != '"' {
			continue
		}
		var value string
		if json.Unmarshal(body[field.valueFrom:field.valueTo], &value) == nil {
			return value, true
		}
	}
	return "", false
}

func patchTopLevelStringField(body []byte, fields []jsonFieldRange, objectEnd int, key, value string) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode patched %s: %w", key, err)
	}
	for _, field := range fields {
		if field.key != key {
			continue
		}
		out := make([]byte, 0, len(body)-field.valueTo+field.valueFrom+len(encoded))
		out = append(out, body[:field.valueFrom]...)
		out = append(out, encoded...)
		out = append(out, body[field.valueTo:]...)
		return out, nil
	}
	// The request object had no model field. Insert it immediately before the
	// closing brace; all existing bytes and unknown fields remain untouched.
	out := make([]byte, 0, len(body)+len(encoded)+len(key)+4)
	out = append(out, body[:objectEnd]...)
	if len(fields) > 0 {
		out = append(out, ',')
	}
	out = append(out, '"')
	out = append(out, key...)
	out = append(out, '"', ':')
	out = append(out, encoded...)
	out = append(out, body[objectEnd:]...)
	return out, nil
}

func skipJSONSpace(body []byte, i int) int {
	for i < len(body) {
		switch body[i] {
		case ' ', '\t', '\r', '\n':
			i++
		default:
			return i
		}
	}
	return i
}

func skipJSONString(body []byte, i int) (int, error) {
	if i >= len(body) || body[i] != '"' {
		return 0, fmt.Errorf("JSON string expected")
	}
	for i = i + 1; i < len(body); i++ {
		switch body[i] {
		case '\\':
			i++
			if i >= len(body) {
				return 0, fmt.Errorf("unterminated JSON escape")
			}
		case '"':
			return i + 1, nil
		}
	}
	return 0, fmt.Errorf("unterminated JSON string")
}

func skipJSONValue(body []byte, i int) (int, error) {
	if i >= len(body) {
		return 0, fmt.Errorf("JSON value expected")
	}
	switch body[i] {
	case '"':
		return skipJSONString(body, i)
	case '{', '[':
		stack := []byte{body[i]}
		for j := i + 1; j < len(body); j++ {
			switch body[j] {
			case '"':
				var err error
				j, err = skipJSONString(body, j)
				if err != nil {
					return 0, err
				}
				j--
			case '{', '[':
				stack = append(stack, body[j])
			case '}', ']':
				if len(stack) == 0 || (body[j] == '}' && stack[len(stack)-1] != '{') || (body[j] == ']' && stack[len(stack)-1] != '[') {
					return 0, fmt.Errorf("mismatched JSON composite value")
				}
				stack = stack[:len(stack)-1]
				if len(stack) == 0 {
					return j + 1, nil
				}
			}
		}
		return 0, fmt.Errorf("unterminated JSON composite value")
	default:
		j := i
		for j < len(body) && body[j] != ',' && body[j] != '}' && body[j] != ']' && body[j] != ' ' && body[j] != '\t' && body[j] != '\r' && body[j] != '\n' {
			j++
		}
		if j == i {
			return 0, fmt.Errorf("JSON value expected")
		}
		return j, nil
	}
}
