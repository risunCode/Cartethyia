package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestRedactionBySensitiveKey(t *testing.T) {
	var buf bytes.Buffer
	log := NewLogger(&buf, LevelInfo)
	log.Info(context.Background(), "auth",
		String("authorization", "Bearer super-secret-token"),
		String("provider", "openai"),
	)
	out := buf.String()
	if strings.Contains(out, "super-secret-token") {
		t.Errorf("authorization header value leaked: %s", out)
	}
	if !strings.Contains(out, RedactedValue) {
		t.Errorf("expected redacted placeholder in output: %s", out)
	}
	if !strings.Contains(out, "openai") {
		t.Errorf("non-sensitive key lost: %s", out)
	}
}

func TestRedactionByExplicitRedactFlag(t *testing.T) {
	var buf bytes.Buffer
	log := NewLogger(&buf, LevelInfo)
	log.Info(context.Background(), "msg", Redacted("prompt", "what is the meaning of life"))
	if strings.Contains(buf.String(), "meaning of life") {
		t.Errorf("explicit Redact flag must hide value: %s", buf.String())
	}
	// Verify the explicit flag is honoured even after WithoutRedaction.
	log = log.WithoutRedaction()
	log.Info(context.Background(), "msg", Redacted("prompt", "another secret"))
	if strings.Contains(buf.String(), "another secret") {
		t.Errorf("Redact flag must override WithoutRedaction: %s", buf.String())
	}
}

func TestRedactionDisabledOnlyAffectsSensitiveKeys(t *testing.T) {
	var buf bytes.Buffer
	log := NewLogger(&buf, LevelInfo).WithoutRedaction()
	log.Info(context.Background(), "auth", String("authorization", "Bearer abc"))
	if !strings.Contains(buf.String(), "Bearer abc") {
		t.Errorf("WithoutRedaction must expose sensitive values verbatim: %s", buf.String())
	}
}

func TestRedactionPreservesCorrelationFields(t *testing.T) {
	var buf bytes.Buffer
	log := NewLogger(&buf, LevelInfo)
	log.Info(context.Background(), "msg",
		String("request_id", "req-123"),
		String("trace_id", "trace-xyz"),
		String("provider", "openai"),
	)
	out := buf.String()
	if !strings.Contains(out, "req-123") || !strings.Contains(out, "trace-xyz") {
		t.Errorf("correlation fields must survive redaction: %s", out)
	}
}

func TestLogSinkWritesRedactedFields(t *testing.T) {
	var buf bytes.Buffer
	log := NewLogger(&buf, LevelInfo)
	sink := LogSink{Logger: log}
	ev := RequestEvent{Surface: SurfaceHTTP, Stage: StageRouteAttempt, Provider: "openai"}
	if err := sink.Emit(context.Background(), ev); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "openai") {
		t.Errorf("event provider lost: %s", out)
	}
	if strings.Contains(out, RedactedValue) {
		t.Errorf("clean event must not contain redacted placeholder: %s", out)
	}
}

func TestRedactionCoversFullSensitiveKeySet(t *testing.T) {
	for k := range defaultSensitiveKeys {
		var buf bytes.Buffer
		log := NewLogger(&buf, LevelInfo)
		log.Info(context.Background(), "msg", String(k, "value-should-not-leak"))
		if strings.Contains(buf.String(), "value-should-not-leak") {
			t.Errorf("sensitive key %q leaked value", k)
		}
	}
}

func TestRedactionSkipsNilValues(t *testing.T) {
	var buf bytes.Buffer
	log := NewLogger(&buf, LevelInfo)
	log.Info(context.Background(), "msg", Error(nil))
	if strings.Contains(buf.String(), "\"error\"") {
		t.Errorf("nil error should be dropped, got: %s", buf.String())
	}
}

func TestLogErrorIncludesErrorField(t *testing.T) {
	var buf bytes.Buffer
	log := NewLogger(&buf, LevelInfo)
	LogError(log, context.Background(), "failed", sentinelErr{}, String("k", "v"))
	out := buf.String()
	if !strings.Contains(out, "\"level\":\"ERROR\"") {
		t.Errorf("expected ERROR level: %s", out)
	}
	var doc map[string]any
	if err := json.Unmarshal(buf.Bytes(), &doc); err != nil {
		t.Fatalf("invalid JSON: %v (%s)", err, out)
	}
	if doc["error"] == nil {
		t.Errorf("error field missing: %v", doc)
	}
}

type sentinelErr struct{}

func (sentinelErr) Error() string { return "sentinel" }
