package codec

// cloneMap returns a shallow copy of a JSON object while preserving nil.
func cloneMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

// cloneMapList copies each JSON object in a list and preserves nil/empty input.
func cloneMapList(in []map[string]any) []map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make([]map[string]any, len(in))
	for i, value := range in {
		out[i] = cloneMap(value)
	}
	return out
}

// cloneValue deep-copies JSON-shaped maps and slices used by protocol codecs.
func cloneValue(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, nested := range typed {
			out[key] = cloneValue(nested)
		}
		return out
	case []map[string]any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = cloneMap(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = cloneValue(item)
		}
		return out
	default:
		return value
	}
}
