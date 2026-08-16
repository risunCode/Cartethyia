package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/observability"
)

type captureLogger struct {
	observability.Logger // NopLogger semantics for unused levels; Error is captured.
	messages             []string
	fields               [][]observability.Field
}

func (c *captureLogger) Error(_ context.Context, msg string, fields ...observability.Field) {
	c.messages = append(c.messages, msg)
	c.fields = append(c.fields, fields)
}

func TestRecoveryConvertsPanicToJSON500(t *testing.T) {
	panicked := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(errors.New("boom: upstream metadata enqueue failed"))
	})
	handler := RequestID(Recovery(nil, panicked))

	req := httptest.NewRequest(http.MethodPost, "http://example.test/v1/chat/completions", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content type = %q", ct)
	}
	if id := rec.Header().Get(HeaderRequestID); id == "" {
		t.Fatal("X-Request-Id must be preserved on the recovery response")
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, rec.Body.String())
	}
	if body.Error.Code != "internal_error" || body.Error.Message != "internal server error" {
		t.Fatalf("envelope = %+v", body.Error)
	}
}

func TestRecoveryKeepsServingAfterPanic(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/panic", func(_ http.ResponseWriter, _ *http.Request) {
		panic("handler defect")
	})
	handler := RequestID(Recovery(nil, mux))

	first := httptest.NewRequest(http.MethodGet, "http://example.test/panic", nil)
	firstRec := httptest.NewRecorder()
	handler.ServeHTTP(firstRec, first)
	if firstRec.Code != http.StatusInternalServerError {
		t.Fatalf("panic status = %d, want 500", firstRec.Code)
	}

	second := httptest.NewRequest(http.MethodGet, "http://example.test/health", nil)
	secondRec := httptest.NewRecorder()
	handler.ServeHTTP(secondRec, second)
	if secondRec.Code != http.StatusOK || secondRec.Body.String() != "ok" {
		t.Fatalf("server stopped serving after panic: status=%d body=%q", secondRec.Code, secondRec.Body.String())
	}
}

func TestRecoveryLogsPanicWithStack(t *testing.T) {
	log := &captureLogger{Logger: observability.NopLogger()}
	handler := Recovery(log, http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		panic("kaboom")
	}))
	req := httptest.NewRequest(http.MethodGet, "http://example.test/console/telemetry", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if len(log.messages) != 1 || log.messages[0] != "http handler panic" {
		t.Fatalf("log messages = %v", log.messages)
	}
	var stack, method, path string
	for _, fields := range log.fields {
		for _, f := range fields {
			switch f.Key {
			case "stack":
				if s, ok := f.Value.(string); ok {
					stack = s
				}
			case "method":
				method, _ = f.Value.(string)
			case "path":
				path, _ = f.Value.(string)
			}
		}
	}
	if !strings.Contains(stack, "goroutine") || !strings.Contains(stack, "TestRecoveryLogsPanicWithStack") {
		t.Fatalf("stack trace missing: %q", stack)
	}
	if method != http.MethodGet || path != "/console/telemetry" {
		t.Fatalf("request context fields: method=%q path=%q", method, path)
	}
}

func TestRecoveryRethrowsErrAbortHandler(t *testing.T) {
	handler := Recovery(nil, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	}))
	defer func() {
		if rec := recover(); rec != http.ErrAbortHandler {
			t.Fatalf("ErrAbortHandler must be re-panicked, got %v", rec)
		}
	}()
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://example.test/", nil))
}
