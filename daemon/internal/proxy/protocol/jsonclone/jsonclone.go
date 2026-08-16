// Package jsonclone provides shallow and deep cloning helpers for the
// generic JSON-shaped values used throughout the proxy protocol stack
// (map[string]any, []map[string]any, []any). It is the single owner of the
// formerly-duplicated cloneMap / cloneMapList / cloneValue / cloneJSONMap /
// cloneJSONValue variants scattered across transforms/ and healing/.
package jsonclone

// CloneMap returns a shallow copy of m. A nil input returns nil so callers
// can pass the result back to JSON encoders that preserve nil maps.
func CloneMap(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// CloneMapList returns a new slice where each element map is shallow-copied
// via CloneMap. A nil or empty input returns nil.
func CloneMapList(in []map[string]any) []map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make([]map[string]any, len(in))
	for i, m := range in {
		out[i] = CloneMap(m)
	}
	return out
}

// CloneValue returns a deep copy of v for the JSON-shaped types the proxy
// stack manipulates: map[string]any, []map[string]any, and []any. Scalar
// values are returned by identity. The result of cloning a []map[string]any
// is a []any whose entries are independently cloned, matching the existing
// cloneValue / cloneJSONValue call sites.
func CloneValue(v any) any {
	switch typed := v.(type) {
	case nil:
		return nil
	case map[string]any:
		out := make(map[string]any, len(typed))
		for k, v := range typed {
			out[k] = CloneValue(v)
		}
		return out
	case []map[string]any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = CloneMap(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i := range typed {
			out[i] = CloneValue(typed[i])
		}
		return out
	default:
		return v
	}
}
