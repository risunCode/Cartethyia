package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestBootstrapSmokeHealth(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler := fixtureHandler(t, upstream.URL)
	request := httptest.NewRequest(http.MethodGet, "/health", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
}

func TestBootstrapSmokeModels(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	// fixtureHandler wires registryCatalog from DefaultRegistry without a
	// durable Catalog repository. /v1/models must succeed even when some
	// builtin providers publish an empty CredentialRef.
	handler := fixtureHandler(t, upstream.URL)
	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}

	var payload struct {
		Object string `json:"object"`
		Data   []struct {
			ID      string `json:"id"`
			Object  string `json:"object"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode models: %v body=%s", err, response.Body.String())
	}
	if payload.Object != "list" {
		t.Fatalf("object = %q, want list", payload.Object)
	}
	if len(payload.Data) == 0 {
		t.Fatal("expected model data")
	}
	if payload.Data[0].ID == "" || payload.Data[0].Object != "model" {
		t.Fatalf("unexpected model entry %#v", payload.Data[0])
	}
	foundAntigravity := false
	for _, entry := range payload.Data {
		if strings.HasPrefix(entry.ID, "antigravity:") {
			foundAntigravity = true
			break
		}
	}
	if !foundAntigravity {
		t.Fatal("expected antigravity models in public catalog despite empty CredentialRef")
	}
}

func TestBootstrapSmokeChatCompletions(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-smoke","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
	}))
	defer upstream.Close()

	handler := fixtureHandler(t, upstream.URL)
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "chatcmpl-smoke") {
		t.Fatalf("body = %s", response.Body.String())
	}
}

func TestRuntimeStartCancelClosesDependencies(t *testing.T) {
	var closed atomic.Bool
	r, err := NewWithOptions(Config{ListenAddress: "127.0.0.1:0"}, RuntimeOptions{
		Dependencies: []RuntimeDependency{{
			Name:     "fixture_dep",
			Required: false,
			Probe:    func(context.Context) error { return nil },
			Close: func(context.Context) error {
				closed.Store(true)
				return nil
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan error, 1)
	go func() { started <- r.Start(ctx) }()

	deadline := time.Now().Add(2 * time.Second)
	for r.Readiness().State == StateStarting && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if r.Readiness().State == StateStarting {
		t.Fatal("runtime did not leave starting state")
	}

	cancel()
	if err := <-started; err != nil {
		t.Fatalf("start/cancel: %v", err)
	}
	if !closed.Load() {
		t.Fatal("dependency Close was not called during graceful shutdown")
	}
}

func TestProductionMissingDatabaseURLIsDependencyRequired(t *testing.T) {
	cfg := Config{Environment: "production"}.WithDefaults()

	_, err := defaultBootstrapDependencies(cfg)
	if err == nil || !strings.Contains(err.Error(), "DatabaseURL is required in production") {
		t.Fatalf("defaultBootstrapDependencies error=%v", err)
	}

	_, err = New(cfg)
	if CodeOf(err) != CodeDependencyRequired {
		t.Fatalf("New code=%q err=%v", CodeOf(err), err)
	}
	var coded *Error
	if !errors.As(err, &coded) || coded == nil {
		t.Fatalf("New error unwrap: %v", err)
	}

	_, err = NewWithHealthArtwork(cfg, "")
	if CodeOf(err) != CodeDependencyRequired {
		t.Fatalf("NewWithHealthArtwork code=%q err=%v", CodeOf(err), err)
	}
}

func TestProductionUnreachableDatabaseURLIsDependencyRequired(t *testing.T) {
	cfg := Config{
		Environment:          "production",
		DatabaseURL:          "postgres://cartethyia:cartethyia@127.0.0.1:1/cartethyia",
		AccountEncryptionKey: "integration-key-material-32-bytes-long",
		ConnectTimeout:       100 * time.Millisecond,
	}.WithDefaults()

	_, err := NewWithHealthArtwork(cfg, "smoke")
	if CodeOf(err) != CodeDependencyRequired {
		t.Fatalf("unreachable NewWithHealthArtwork code=%q err=%v", CodeOf(err), err)
	}
	if err == nil || !strings.Contains(err.Error(), "PostgreSQL") {
		t.Fatalf("expected PostgreSQL bootstrap failure, got %v", err)
	}

	_, err = New(cfg)
	if CodeOf(err) != CodeDependencyRequired {
		t.Fatalf("unreachable New code=%q err=%v", CodeOf(err), err)
	}
}

func TestRuntimeHandlerAndReadinessNilPaths(t *testing.T) {
	var nilRuntime *Runtime
	if nilRuntime.Handler() != nil {
		t.Fatal("nil runtime Handler should be nil")
	}
	if got := nilRuntime.Readiness(); got.State != StateStopped {
		t.Fatalf("nil runtime Readiness=%#v", got)
	}

	r, err := NewWithOptions(Config{ListenAddress: "127.0.0.1:0"}, RuntimeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if r.Handler() == nil {
		t.Fatal("constructed runtime Handler should be non-nil")
	}
	if got := r.Readiness(); got.State != StateStarting {
		t.Fatalf("fresh runtime Readiness=%#v", got)
	}
}
