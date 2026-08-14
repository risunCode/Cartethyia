package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSecurityVerificationRedactsSecretsFromSerializedErrors(t *testing.T) {
	const secret = "sk-live-secret-value"
	var buf bytes.Buffer
	logger := NewLogger(&buf, LevelError)
	LogError(logger, context.Background(), "upstream failed", errors.New("authorization: Bearer "+secret))

	if strings.Contains(buf.String(), secret) {
		t.Fatalf("serialized error leaked secret: %s", buf.String())
	}
	var record map[string]any
	if err := json.Unmarshal(buf.Bytes(), &record); err != nil {
		t.Fatalf("invalid serialized log: %v", err)
	}
	if got, ok := record["error"].(string); !ok || got != RedactedValue {
		t.Fatalf("error field was not redacted: %#v", record["error"])
	}
}

func TestSecurityVerificationRejectsSecretShapedMetricIdentifiers(t *testing.T) {
	const secret = "sk-live-secret-value"
	reg := NewRegistry()
	err := reg.RecordEvent(context.Background(), RequestEvent{
		Stage:    StageProviderCall,
		Surface:  SurfaceHTTP,
		Provider: "openai",
		Model:    "api_key=" + secret,
	})
	if err == nil || !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("secret-shaped model accepted: %v", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("metric validation error leaked secret: %v", err)
	}

	recorder := httptest.NewRecorder()
	reg.ServeHTTP(recorder)
	if strings.Contains(recorder.Body.String(), secret) {
		t.Fatalf("metric output leaked secret: %s", recorder.Body.String())
	}
}
