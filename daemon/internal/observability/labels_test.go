package observability

import (
	"strings"
	"testing"
)

func TestSanitizeLabelKey(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Provider", "provider"},
		{"  Model  ", "model"},
		{"", ""},
		{"\t\n", ""},
	}
	for _, tc := range cases {
		if got := SanitizeLabelKey(tc.in); got != tc.want {
			t.Errorf("SanitizeLabelKey(%q)=%q want %q", tc.in, got, tc.want)
		}
	}
	// Truncation behaviour
	big := strings.Repeat("a", MaxLabelKeyLen+10)
	got := SanitizeLabelKey(big)
	if len(got) != MaxLabelKeyLen {
		t.Errorf("oversize key truncated to %d want %d", len(got), MaxLabelKeyLen)
	}
}

func TestSanitizeLabelValue(t *testing.T) {
	if v := SanitizeLabelValue(""); v != "" {
		t.Errorf("empty should remain empty, got %q", v)
	}
	if v := SanitizeLabelValue("ok"); v != "ok" {
		t.Errorf("short value should pass through, got %q", v)
	}
	big := strings.Repeat("a", MaxLabelValueLen+10)
	if v := SanitizeLabelValue(big); v != "other" {
		t.Errorf("oversize value must coerce to 'other', got %q", v)
	}
}

func TestLabelValidatorAcceptsAllowedKeys(t *testing.T) {
	v := NewLabelValidator()
	labels := []Label{
		{Key: "provider", Value: "openai"},
		{Key: "model", Value: "gpt-4o-mini"},
		{Key: "surface", Value: "http"},
		{Key: "outcome", Value: string(OutcomeSuccess)},
		{Key: "cache_kind", Value: CacheKindResolutionMemory.String()},
		{Key: "cache_layer", Value: "memory"},
		{Key: "hit", Value: "true"},
		{Key: "error_class", Value: "rate_limit"},
	}
	if err := v.Validate(labels); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestLabelValidatorRejectsReservedKeys(t *testing.T) {
	v := NewLabelValidator()
	for _, k := range []string{"request_id", "trace_id", "span_id", "authorization", "x-api-key", "prompt", "body"} {
		err := v.Validate([]Label{{Key: k, Value: "x"}})
		if err == nil {
			t.Errorf("reserved key %q should be rejected", k)
			continue
		}
		le, ok := err.(*LabelError)
		if !ok || le.Key != k {
			t.Errorf("reserved key %q: want LabelError{Key:%q}, got %v", k, k, err)
		}
	}
}

func TestLabelValidatorRejectsUnknownKeys(t *testing.T) {
	v := NewLabelValidator()
	err := v.Validate([]Label{{Key: "free_text_field", Value: "v"}})
	if err == nil {
		t.Fatalf("expected rejection of unknown key")
	}
	if !strings.Contains(err.Error(), "allowlist") {
		t.Errorf("expected allowlist error, got %v", err)
	}
}

func TestLabelValidatorBoundsLabelsPerEvent(t *testing.T) {
	v := NewLabelValidator()
	labels := make([]Label, MaxLabelsPerEvent+1)
	allowed := []string{"provider", "model", "surface", "outcome", "stage", "cache_kind", "cache_layer", "hit", "error_class", "stream_mode"}
	for i := range labels {
		labels[i] = Label{Key: allowed[i%len(allowed)], Value: "v"}
	}
	if err := v.Validate(labels); err == nil {
		t.Fatalf("expected too-many-labels rejection")
	}
}

func TestLabelValidatorRejectsRawContentSizedValues(t *testing.T) {
	v := NewLabelValidator()
	huge := strings.Repeat("x", MaxRawValueBytes+1)
	err := v.Validate([]Label{{Key: "provider", Value: huge}})
	if err == nil {
		t.Fatalf("expected rejection of raw-content-sized value")
	}
}

func TestLabelValidatorNormalizeDropsReservedAndUnknown(t *testing.T) {
	v := NewLabelValidator()
	out, err := v.Normalize([]Label{
		{Key: "REQUEST_ID", Value: "abc"},
		{Key: "provider", Value: "OpenAI"},
		{Key: "free_field", Value: "ignored"},
		{Key: "model", Value: "x"},
	})
	if err == nil {
		t.Fatalf("expected non-nil error for reserved/unknown keys")
	}
	if len(out) != 2 {
		t.Fatalf("expected 2 surviving labels, got %d: %#v", len(out), out)
	}
	if out[0].Key != "provider" || out[0].Value != "OpenAI" {
		t.Errorf("provider label not normalised: %#v", out[0])
	}
	if out[1].Key != "model" {
		t.Errorf("model label missing: %#v", out[1])
	}
}

func TestLabelValidatorNormalizeDedupesKeys(t *testing.T) {
	v := NewLabelValidator()
	out, err := v.Normalize([]Label{
		{Key: "provider", Value: "openai"},
		{Key: "PROVIDER", Value: "anthropic"},
	})
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if len(out) != 1 || out[0].Value != "anthropic" {
		t.Errorf("expected last value wins, got %#v", out)
	}
}

func TestAllowListAndReservedKeysReturnCopies(t *testing.T) {
	a := AllowList()
	delete(a, "provider")
	if _, ok := AllowList()["provider"]; !ok {
		t.Fatalf("AllowList must return independent copies")
	}
	r := ReservedKeys()
	delete(r, "request_id")
	if _, ok := ReservedKeys()["request_id"]; !ok {
		t.Fatalf("ReservedKeys must return independent copies")
	}
}

func TestLabelValidatorRejectsEmptyKey(t *testing.T) {
	v := NewLabelValidator()
	if err := v.Validate([]Label{{Key: "", Value: "v"}}); err == nil {
		t.Errorf("expected rejection of empty key")
	}
	if err := v.Validate([]Label{{Key: "  ", Value: "v"}}); err == nil {
		t.Errorf("expected rejection of whitespace-only key")
	}
}

func TestLabelValidatorRejectsOversizeValue(t *testing.T) {
	v := NewLabelValidator()
	big := strings.Repeat("a", MaxLabelValueLen+1)
	if err := v.Validate([]Label{{Key: "provider", Value: big}}); err == nil {
		t.Errorf("expected rejection of oversize value")
	}
}
