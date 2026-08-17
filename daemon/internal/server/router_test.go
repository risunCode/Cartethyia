package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/observability"
)

func TestRouterRejectsMissingRegistry(t *testing.T) {
	if _, err := NewRouterWith(Options{}); err == nil {
		t.Fatal("nil registry accepted")
	}
	if _, err := NewRouter(nil); err == nil {
		t.Fatal("nil registry accepted by NewRouter")
	}
}

func TestHealthRendersServingHeaderAndArtwork(t *testing.T) {
	handler, err := NewRouterWith(Options{
		Registry:      observability.NewRegistry(),
		HealthArtwork: "<pre>ASCII-CARTE</pre>",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/health", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	body := response.Body.String()
	for _, fragment := range []string{
		"Cartethyia is serving",
		"==================================",
		"Baseurl: http://example.com/v1",
		"Endpoint:",
		"POST /v1/chat/completions",
		"POST /v1/responses",
		"POST /v1/messages",
		"Media Generation",
		"ASCII-CARTE",
	} {
		if !strings.Contains(body, fragment) {
			t.Fatalf("health body missing %q: %s", fragment, body)
		}
	}
	if got := response.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("content type = %q", got)
	}
	if requestID := response.Header().Get("X-Request-Id"); requestID == "" {
		t.Fatal("missing generated request id")
	}
	if traceID := response.Header().Get("X-Trace-Id"); traceID == "" {
		t.Fatal("missing generated trace id")
	}
}

func TestRouterServesDashboardAndSPAFallback(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<main>dashboard</main>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(directory, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "assets", "app.js"), []byte("console.log('ok')"), 0o644); err != nil {
		t.Fatal(err)
	}
	handler, err := NewRouterWith(Options{
		Registry:     observability.NewRegistry(),
		DashboardDir: directory,
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		path string
		want string
	}{
		{path: "/", want: "<main>dashboard</main>"},
		{path: "/overview", want: "<main>dashboard</main>"},
		{path: "/assets/app.js", want: "console.log('ok')"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d", test.path, response.Code)
		}
		if got := response.Body.String(); got != test.want {
			t.Fatalf("%s body = %q, want %q", test.path, got, test.want)
		}
	}
}
