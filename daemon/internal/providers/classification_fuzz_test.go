package providers

import (
	"net/http"
	"strings"
	"testing"
)

func FuzzFailureMarkerClassification(f *testing.F) {
	const secretSentinel = "credential-SENTINEL-provider-marker"
	seeds := []struct {
		status uint16
		body   []byte
	}{
		{status: http.StatusOK, body: []byte(`{"id":"response"}`)},
		{status: http.StatusUnauthorized, body: []byte(`{"error":{"code":"token_expired"}}`)},
		{status: http.StatusForbidden, body: []byte(`{"error":{"code":"subscription_required"}}`)},
		{status: http.StatusTooManyRequests, body: []byte(`{"error":{"code":"rate_limit_exceeded"}}`)},
		{status: http.StatusTooManyRequests, body: []byte(`{"error":{"code":"insufficient_quota"}}`)},
		{status: http.StatusServiceUnavailable, body: []byte(`{"error":{"code":"model_overloaded"}}`)},
		{status: http.StatusBadRequest, body: []byte(`{"error":{"message":"` + secretSentinel + `"}}`)},
	}
	for _, seed := range seeds {
		f.Add(seed.status, seed.body)
	}

	f.Fuzz(func(t *testing.T, encodedStatus uint16, body []byte) {
		if len(body) > 2*MaxResponseEvidenceBodyBytes {
			body = body[:2*MaxResponseEvidenceBodyBytes]
		}
		status := int(encodedStatus)
		if status < 100 || status > 699 {
			status = int(encodedStatus%600) + 100
		}
		evidence := NewResponseEvidence(status, nil, body)
		if len(evidence.BodyPrefix) > MaxResponseEvidenceBodyBytes {
			t.Fatalf("evidence body prefix=%d, want <=%d", len(evidence.BodyPrefix), MaxResponseEvidenceBodyBytes)
		}
		first := ClassifyResponseEvidence(evidence)
		second := ClassifyResponseEvidence(evidence)
		if first != second {
			t.Fatalf("classification is nondeterministic: first=%+v second=%+v", first, second)
		}
		if first.Code == "" || first.Category == "" {
			t.Fatalf("classification lacks stable code/category: %+v", first)
		}
		if len(first.Code) > 128 || len(first.Message) > 256 {
			t.Fatalf("classification output is unbounded: code=%d message=%d", len(first.Code), len(first.Message))
		}
		if strings.Contains(first.Code, secretSentinel) || strings.Contains(first.Message, secretSentinel) {
			t.Fatalf("classification leaked secret sentinel: %+v", first)
		}
	})
}
