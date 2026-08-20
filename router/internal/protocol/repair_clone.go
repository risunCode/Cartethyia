package protocol

// cloneRepairMap copies one repair-owned JSON object before normalization.
// Repair rules never mutate caller-owned payload maps in place.
func cloneRepairMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
