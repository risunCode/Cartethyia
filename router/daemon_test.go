package daemon_test

import (
	"context"
	"github.com/cartethyia/daemon"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerHealthAndUnknownRoutes(t *testing.T) {
	runtime, err := daemon.New(daemon.Config{ListenAddress: ":8080"})
	if err != nil {
		t.Fatalf("new runtime: %v", err)
	}

	tests := []struct {
		name        string
		path        string
		wantStatus  int
		wantBodies  []string
		wantContent string
	}{
		{
			name:       "health",
			path:       "/health",
			wantStatus: http.StatusOK,
			wantBodies: []string{
				"Cartethyia is serving",
				"==================================",
				"Baseurl: http://example.com/v1",
				"Endpoint:",
				"POST /v1/chat/completions",
				"POST /v1/responses",
				"Media Generation",
			},
			wantContent: "text/html; charset=utf-8",
		},
		{
			name:       "unknown",
			path:       "/missing",
			wantStatus: http.StatusNotFound,
			wantBodies: []string{"route not found"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, tt.path, nil)
			recorder := httptest.NewRecorder()

			runtime.Handler().ServeHTTP(recorder, request)

			if recorder.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, tt.wantStatus)
			}
			body := recorder.Body.String()
			for _, want := range tt.wantBodies {
				if !strings.Contains(body, want) {
					t.Fatalf("body = %q, want fragment %q", body, want)
				}
			}
			if tt.wantContent != "" && recorder.Header().Get("Content-Type") != tt.wantContent {
				t.Fatalf("content type = %q, want %q", recorder.Header().Get("Content-Type"), tt.wantContent)
			}
		})
	}
}

func TestHandlerRejectsUnsupportedMethods(t *testing.T) {
	runtime, err := daemon.New(daemon.Config{ListenAddress: ":8080"})
	if err != nil {
		t.Fatalf("new runtime: %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/health", nil)
	recorder := httptest.NewRecorder()
	runtime.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
	if got := recorder.Header().Get("Allow"); got != http.MethodGet {
		t.Fatalf("allow = %q, want %q", got, http.MethodGet)
	}
}
func TestRuntimeReadinessTracksLifecycle(t *testing.T) {
	runtime, err := daemon.New(daemon.Config{ListenAddress: ":0"})
	if err != nil {
		t.Fatalf("new runtime: %v", err)
	}
	initial := runtime.Readiness()
	if initial.State != daemon.StateStarting || !initial.Live || initial.Ready {
		t.Fatalf("initial readiness = %#v", initial)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runtime.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	stopped := runtime.Readiness()
	if stopped.State != daemon.StateStopped || stopped.Live || stopped.Ready {
		t.Fatalf("stopped readiness = %#v", stopped)
	}
}
