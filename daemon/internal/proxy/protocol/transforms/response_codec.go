package transforms

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// maxResponseBodyBytes bounds every provider/canonical response body that the
// codec helpers touch. Bodies above this length are rejected with a typed
// bounded error rather than silently truncated, so callers can observe the
// failure before any byte crosses the dispatch boundary.
const maxResponseBodyBytes = 16 << 20

// boundedResponseBody returns a typed error when the body is empty or above
// the response bound. The decoder/encoder helpers never allocate beyond the
// bound so the runtime cannot be coerced into a large allocation.
func boundedResponseBody(surface contracts.Protocol, body []byte) (*TransformError, bool) {
	if len(body) == 0 {
		return errDecodeResponse(surface, "body", "response body is empty"), false
	}
	if len(body) > maxResponseBodyBytes {
		return errDecodeResponse(surface, "body", "response body exceeded bound"), false
	}
	return nil, true
}

// decodeResponseBody unmarshals a response body into a generic map while
// preserving decoder-friendly error reporting.
func decodeResponseBody(surface contracts.Protocol, body []byte) (map[string]any, *TransformError) {
	if terr, ok := boundedResponseBody(surface, body); !ok {
		return nil, terr
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil || root == nil {
		return nil, errDecodeResponse(surface, "body", "response body must be a JSON object")
	}
	return root, nil
}

// responseString extracts a string field with bounded length.
func responseString(value any) string {
	s, _ := value.(string)
	return s
}

// responseInt extracts a non-negative integer from a numeric JSON field. The
// decoder only accepts whole numbers so downstream usage never sees a
// truncated float silently coerced to zero.
func responseInt(value any) (int, bool) {
	switch v := value.(type) {
	case float64:
		if v < 0 || v != float64(int(v)) {
			return 0, false
		}
		return int(v), true
	case int:
		if v < 0 {
			return 0, false
		}
		return v, true
	case int64:
		if v < 0 {
			return 0, false
		}
		return int(v), true
	default:
		return 0, false
	}
}

// responseUsage maps a provider usage payload into the canonical usage
// structure. Dimensions that are absent remain zero.
func responseUsage(raw map[string]any) Usage {
	out := Usage{}
	if raw == nil {
		return out
	}
	if details, ok := raw["prompt_tokens_details"].(map[string]any); ok {
		if v, ok := responseInt(details["cached_tokens"]); ok {
			out.CacheReadTokens = v
			out.CacheRead = v
		}
	}
	if details, ok := raw["input_tokens_details"].(map[string]any); ok {
		if v, ok := responseInt(details["cached_tokens"]); ok && out.CacheReadTokens == 0 {
			out.CacheReadTokens = v
			out.CacheRead = v
		}
	}
	if details, ok := raw["output_tokens_details"].(map[string]any); ok {
		if v, ok := responseInt(details["reasoning_tokens"]); ok {
			out.ReasoningTokens = v
		}
	}
	if v, ok := responseInt(raw["input_tokens"]); ok {
		out.InputTokens = v
	}
	if v, ok := responseInt(raw["output_tokens"]); ok {
		out.OutputTokens = v
	}
	if v, ok := responseInt(raw["total_tokens"]); ok {
		out.TotalTokens = v
	} else if out.TotalTokens == 0 {
		out.TotalTokens = out.InputTokens + out.OutputTokens
	}
	if v, ok := responseInt(raw["reasoning_tokens"]); ok {
		out.ReasoningTokens = v
	}
	if v, ok := responseInt(raw["cache_read_input_tokens"]); ok {
		out.CacheReadTokens = v
		out.CacheRead = v
	}
	if v, ok := responseInt(raw["cache_creation_input_tokens"]); ok {
		out.CacheWriteTokens = v
		out.CacheWrite = v
	}
	if v, ok := responseInt(raw["cached_tokens"]); ok && out.CacheReadTokens == 0 {
		out.CacheReadTokens = v
		out.CacheRead = v
	}
	if v, ok := responseInt(raw["output_tokens"]); ok && out.OutputTokens == 0 {
		out.OutputTokens = v
	}
	if v, ok := responseInt(raw["completion_tokens"]); ok && out.OutputTokens == 0 {
		out.OutputTokens = v
	}
	return out
}

// emitUsage appends a single bounded usage event to the response if the
// canonical usage carries any non-zero dimension.
func emitUsage(response *NormalizedResponse) {
	if response == nil || response.Usage == nil {
		return
	}
	usage := *response.Usage
	if usage.InputTokens == 0 && usage.OutputTokens == 0 && usage.TotalTokens == 0 &&
		usage.ReasoningTokens == 0 && usage.CacheRead == 0 && usage.CacheWrite == 0 {
		return
	}
	response.Events = append(response.Events, NormalizedEvent{Type: EventUsage, Usage: &usage})
}

// stopReasonFromString maps a provider finish reason onto the canonical
// stop reason set. Unknown values fall back to StopCompleted rather than
// surfacing as a stop-error.
func stopReasonFromString(value string) StopReason {
	switch strings.ToLower(value) {
	case "stop", "stop_completed", "completed", "end_turn":
		return StopCompleted
	case "length", "max_tokens", "max_output_tokens":
		return StopLength
	case "tool_calls", "tool_use", "function_call":
		return StopToolCall
	case "content_filter", "refusal", "safety":
		return StopContentFilter
	case "error", "failed":
		return StopError
	default:
		return StopCompleted
	}
}

// stopReasonFromStatus maps a provider top-level status to the canonical
// stop reason. Used when the response carries explicit lifecycle state
// instead of a finish reason.
func stopReasonFromStatus(status string) StopReason {
	switch strings.ToLower(status) {
	case "completed":
		return StopCompleted
	case "incomplete":
		return StopLength
	case "failed":
		return StopError
	case "canceled", "cancelled":
		return StopError
	default:
		return ""
	}
}

// responseStatusFromStatus returns the canonical lifecycle status for a
// provider-reported status string.
func responseStatusFromStatus(value string) ItemStatus {
	switch strings.ToLower(value) {
	case "completed":
		return ItemStatusCompleted
	case "incomplete":
		return ItemStatusIncomplete
	case "failed":
		return ItemStatusFailed
	case "canceled", "cancelled":
		return ItemStatusCanceled
	default:
		return ""
	}
}

// finalizeResponse emits terminal events and assigns the canonical status.
func finalizeResponse(response *NormalizedResponse, stop StopReason, status ItemStatus) {
	if response == nil {
		return
	}
	if stop != "" {
		response.StopReason = stop
		response.Events = append(response.Events, NormalizedEvent{Type: EventResponseCompleted, StopReason: &stop, Status: status})
	}
	if status != "" {
		response.Status = status
	}
}

// requireContext returns a typed error when the supplied context is nil or
// already canceled. The codec helpers never panic on nil context.
func requireContext(surface contracts.Protocol, ctx context.Context) *TransformError {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return newTransformError(CodeContextCanceled, "response", string(surface), "context", "response operation canceled", err)
	}
	return nil
}

// requireResponse returns a typed error when the canonical response is nil.
func requireResponse(surface contracts.Protocol, response *NormalizedResponse) *TransformError {
	if response == nil {
		return errEncodeResponse(surface, "response", "response must not be nil")
	}
	return nil
}

// decodeEventsFromOutput walks an ordered provider output array and emits
// canonical events with stable indexes. The decoder keeps the same item
// order across surfaces so encoders can rely on deterministic framing.
func decodeEventsFromOutput(surface contracts.Protocol, response *NormalizedResponse, output []any, decoder func(surface contracts.Protocol, response *NormalizedResponse, index int, raw map[string]any) error) error {
	if response == nil {
		return errDecodeResponse(surface, "output", "response must not be nil")
	}
	for i, raw := range output {
		obj, ok := raw.(map[string]any)
		if !ok {
			return errDecodeResponse(surface, fmt.Sprintf("output[%d]", i), "output item must be an object")
		}
		if err := decoder(surface, response, i, obj); err != nil {
			return err
		}
	}
	return nil
}

// appendStreamEvent guards event appends against nil responses.
func appendStreamEvent(response *NormalizedResponse, event NormalizedEvent) {
	if response == nil {
		return
	}
	response.Events = append(response.Events, event)
}
