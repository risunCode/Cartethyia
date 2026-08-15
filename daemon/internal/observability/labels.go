// Bounded metric labels for the daemon observability package.
package observability

import (
	"fmt"
	"strings"
	"sync"
)

// Bounds for metric labels.
const (
	// MaxLabelKeyLen is the maximum allowed length of a metric label key.
	MaxLabelKeyLen = 64
	// MaxLabelValueLen is the maximum allowed length of a metric label value.
	// Oversize values are coerced to "other" so the metric series does not
	// explode in cardinality.
	MaxLabelValueLen = 96
	// MaxLabelsPerEvent is the maximum number of labels emitted per event.
	MaxLabelsPerEvent = 16
	// MaxRawValueBytes is the upper bound on a single string field accepted
	// by RequestEvent. Values exceeding this size are rejected because they
	// strongly suggest raw prompt or response content slipped into a label.
	MaxRawValueBytes = 1024
)

// Label is a single bounded metric label. Both key and value are restricted
// to plain strings — no nested structures can leak into the metric pipeline.
type Label struct {
	Key   string
	Value string
}

// DefaultLabelAllowList is the canonical set of label keys permitted by the
// bounded metric emit path. Adding new entries here is a deliberate
// cardinality decision and MUST be reviewed. Request IDs, trace IDs, raw
// prompt content, and credential-shaped keys are intentionally absent.
var DefaultLabelAllowList = map[string]struct{}{
	"provider":           {},
	"model":              {},
	"surface":            {},
	"outcome":            {},
	"stage":              {},
	"cache_kind":         {},
	"cache_layer":        {},
	"hit":                {},
	"error_class":        {},
	"stream_mode":        {},
	"source_surface":     {},
	"target_surface":     {},
	"profile":            {},
	"action":             {},
	"operation":          {},
	"compaction_version": {},
	"bridge":             {},
	"cache_operation":    {},
	"cache_result":       {},
	"recovery":           {},
	"exhaustion_reason":  {},
	"capability_code":    {},
	"modality":           {},
	"reference_kind":     {},
}

// ReservedLabelKeys are keys that must NEVER appear as metric labels.
// Reserved keys fall into two groups:
//   - high-cardinality correlation identifiers (request_id, trace_id, span_id)
//   - credential-shaped values that would defeat redaction
//
// Metric paths reject these keys even if a caller passes them explicitly.
var ReservedLabelKeys = map[string]struct{}{
	"request_id":          {},
	"trace_id":            {},
	"span_id":             {},
	"authorization":       {},
	"proxy-authorization": {},
	"cookie":              {},
	"set-cookie":          {},
	"token":               {},
	"access_token":        {},
	"refresh_token":       {},
	"id_token":            {},
	"bearer":              {},
	"x-api-key":           {},
	"api-key":             {},
	"apikey":              {},
	"password":            {},
	"secret":              {},
	"client_secret":       {},
	"credential":          {},
	"credentials":         {},
	"prompt":              {},
	"messages":            {},
	"input":               {},
	"output":              {},
	"body":                {},
	"raw":                 {},
}

// AllowList returns a copy of DefaultLabelAllowList. Callers that need to
// extend the list for a specific scope should compose a new map and validate
// against it; the package default is intentionally immutable at runtime.
func AllowList() map[string]struct{} {
	out := make(map[string]struct{}, len(DefaultLabelAllowList))
	for k := range DefaultLabelAllowList {
		out[k] = struct{}{}
	}
	return out
}

// ReservedKeys returns a copy of ReservedLabelKeys.
func ReservedKeys() map[string]struct{} {
	out := make(map[string]struct{}, len(ReservedLabelKeys))
	for k := range ReservedLabelKeys {
		out[k] = struct{}{}
	}
	return out
}

// SanitizeLabelKey normalises a metric label key. Empty or whitespace-only
// keys are rejected (returns ""). Oversize keys are truncated to
// MaxLabelKeyLen. The returned key is lowercased so case-only differences do
// not create duplicate series.
func SanitizeLabelKey(key string) string {
	key = strings.ToLower(strings.TrimSpace(key))
	if key == "" {
		return ""
	}
	if len(key) > MaxLabelKeyLen {
		key = key[:MaxLabelKeyLen]
	}
	return key
}

// SanitizeLabelValue normalises a metric label value. Empty values are
// preserved (callers distinguish absent from empty). Oversize values are
// coerced to the literal "other" so cardinality is bounded.
func SanitizeLabelValue(value string) string {
	if value == "" {
		return ""
	}
	if len(value) > MaxLabelValueLen {
		return "other"
	}
	return value
}

// LabelError describes why a label set was rejected.
type LabelError struct {
	Reason string
	Key    string
}

func (e *LabelError) Error() string {
	if e.Key == "" {
		return "label: " + e.Reason
	}
	return fmt.Sprintf("label %q: %s", e.Key, e.Reason)
}

// labelValidator caches the resolved allow/deny sets so repeated validations
// stay cheap. It is safe for concurrent use.
type labelValidator struct {
	allow map[string]struct{}
	deny  map[string]struct{}
	once  sync.Once
}

// NewLabelValidator constructs a validator that enforces the package default
// allowlist and reserved-key denylist. Pass AllowList() / ReservedKeys()
// derivatives to extend.
func NewLabelValidator() *labelValidator {
	return &labelValidator{
		allow: AllowList(),
		deny:  ReservedKeys(),
	}
}

// Validate returns nil if labels are within bounds and permitted, otherwise
// a *LabelError explaining the rejection. Empty labels are rejected (the
// caller likely forgot a key). Duplicate keys collapse silently — the last
// value wins, matching Prometheus convention.
func (v *labelValidator) Validate(labels []Label) error {
	if len(labels) > MaxLabelsPerEvent {
		return &LabelError{Reason: fmt.Sprintf("too many labels: %d > %d", len(labels), MaxLabelsPerEvent)}
	}
	seen := make(map[string]struct{}, len(labels))
	for _, l := range labels {
		key := SanitizeLabelKey(l.Key)
		if key == "" {
			return &LabelError{Reason: "empty key"}
		}
		if _, reserved := v.deny[key]; reserved {
			return &LabelError{Reason: "reserved key", Key: key}
		}
		if _, allowed := v.allow[key]; !allowed {
			return &LabelError{Reason: "key not in allowlist", Key: key}
		}
		if len(l.Value) > MaxLabelValueLen {
			return &LabelError{Reason: fmt.Sprintf("value too long: %d > %d", len(l.Value), MaxLabelValueLen), Key: key}
		}
		if len(l.Value) > MaxRawValueBytes {
			return &LabelError{Reason: "value resembles raw content", Key: key}
		}
		seen[key] = struct{}{}
	}
	return nil
}

// Normalize validates and rewrites labels into a canonical, metric-safe
// form. Invalid labels are dropped with a single error returned describing
// the first rejection; the remaining labels are still normalised for
// inspection. Callers that must fail-closed on any rejection should call
// Validate first and use Normalize only on the validated set.
func (v *labelValidator) Normalize(labels []Label) ([]Label, error) {
	normalized := make(map[string]Label, len(labels))
	orderedKeys := make([]string, 0, len(labels))
	var firstErr error
	for _, l := range labels {
		key := SanitizeLabelKey(l.Key)
		if key == "" {
			if firstErr == nil {
				firstErr = &LabelError{Reason: "empty key"}
			}
			continue
		}
		if _, reserved := v.deny[key]; reserved {
			if firstErr == nil {
				firstErr = &LabelError{Reason: "reserved key", Key: key}
			}
			continue
		}
		if _, allowed := v.allow[key]; !allowed {
			if firstErr == nil {
				firstErr = &LabelError{Reason: "key not in allowlist", Key: key}
			}
			continue
		}
		value := SanitizeLabelValue(l.Value)
		if len(value) > MaxRawValueBytes {
			if firstErr == nil {
				firstErr = &LabelError{Reason: "value resembles raw content", Key: key}
			}
			continue
		}
		// Assigning rather than skipping duplicates makes the last value win.
		if _, exists := normalized[key]; !exists {
			orderedKeys = append(orderedKeys, key)
		}
		normalized[key] = Label{Key: key, Value: value}
	}
	out := make([]Label, 0, len(orderedKeys))
	for _, key := range orderedKeys {
		out = append(out, normalized[key])
		if len(out) == MaxLabelsPerEvent {
			break
		}
	}
	return out, firstErr
}
