package server

import (
	"errors"
	"html"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/server/middleware"
)

func dashboardHandler(directory string) http.Handler {
	files := http.FileServer(http.Dir(directory))
	indexPath := filepath.Join(directory, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeMethodNotAllowed(w, http.MethodGet)
			return
		}
		if _, err := os.Stat(indexPath); err != nil {
			handleNotFound(w, r)
			return
		}
		cleanPath := filepath.Clean(filepath.FromSlash(r.URL.Path))
		if cleanPath != "." && cleanPath != string(filepath.Separator) {
			candidate := filepath.Join(directory, cleanPath)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				files.ServeHTTP(w, r)
				return
			}
		}
		http.ServeFile(w, r, indexPath)
	})
}

// NewRouter builds the foundation HTTP boundary without extension registrars.
func NewRouter(registry *observability.Registry) (http.Handler, error) {
	return NewRouterWith(Options{Registry: registry})
}

// NewRouterWith composes the foundation router. Required dependencies return
// configuration errors instead of panicking.
func NewRouterWith(opts Options) (http.Handler, error) {
	if opts.Registry == nil {
		return nil, errors.New("server: options registry is required")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler(opts.HealthArtwork))
	mux.HandleFunc("/metrics", handleMetrics(opts.Registry))
	registerV1(mux, opts.V1, opts.V1Auth)
	registerConsole(mux, opts.Console)
	registerShare(mux, opts.Share)
	if opts.DashboardDir == "" {
		mux.HandleFunc("/", handleNotFound)
	} else {
		mux.Handle("/", dashboardHandler(opts.DashboardDir))
	}
	// Recovery sits directly inside RequestID so a panic anywhere downstream
	// still produces the JSON error envelope with the correlated request id.
	return middleware.RequestID(middleware.Recovery(opts.Registry.Logger(), observeRequests(opts.Registry, mux))), nil
}

// observeRequests records the wall-clock duration of every request.
// The previous version measured the duration before dispatching to the
// next handler, which always recorded ~0. The defer ensures the timer
// captures downstream work even when handlers panic.
func observeRequests(registry *observability.Registry, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		defer func() {
			registry.ObserveRequest(r.Method, r.URL.Path, time.Since(started))
		}()
		next.ServeHTTP(w, r)
	})
}

// healthHandler reports liveness. The optional artwork is deliberately
// presentation-only; health remains a GET-only endpoint.
func healthHandler(artwork string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, http.MethodGet)
			return
		}
		if artwork == "" {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, healthPage(r, artwork))
	}
}

func healthPage(r *http.Request, artwork string) string {
	baseURL := html.EscapeString(requestBaseURL(r))
	const endpoints = `<div style="margin-top:16px">Endpoint:</div><pre style="margin:4px 0 0">OpenAI
  POST /v1/chat/completions
  POST /v1/responses

Anthropic
  POST /v1/messages

Media Generation
  POST /v1/images/generations
  POST /v1/images/edits</pre>`
	return `<!doctype html><html><head><meta charset="utf-8"><title>Cartethyia</title></head><body style="background:#000;color:#f4d7b8;font-family:monospace;margin:0;padding:24px"><main><h1>Cartethyia is serving</h1><div>==================================</div><div>Baseurl: ` + baseURL + `</div>` + endpoints + `<div style="margin-top:16px">` + artwork + `</div></main></body></html>`
}

func requestBaseURL(r *http.Request) string {
	scheme := firstForwardedValue(r.Header.Get("X-Forwarded-Proto"))
	if scheme == "" {
		scheme = r.URL.Scheme
	}
	if scheme == "" {
		scheme = "http"
		if r.TLS != nil {
			scheme = "https"
		}
	}
	host := firstForwardedValue(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = r.Host
	}
	if host == "" {
		host = "localhost"
	}
	return scheme + "://" + host + "/v1"
}

func firstForwardedValue(value string) string {
	if comma := strings.IndexByte(value, ','); comma >= 0 {
		value = value[:comma]
	}
	return strings.TrimSpace(value)
}

// handleMetrics exposes the registry's Prometheus text output. Metrics
// rendering is a server-side read, so the endpoint is GET-only and the
// Allow header makes that contract explicit to monitoring clients.
func handleMetrics(registry *observability.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, http.MethodGet)
			return
		}
		registry.ServeHTTP(w)
	}
}

// registerV1 wires the /v1/ route group. A nil registrar leaves the prefix
// on the shared "not implemented" placeholder; a non-nil registrar owns
// the subtree exclusively.
func registerV1(mux *http.ServeMux, v1 V1Registrar, auth func(http.Handler) http.Handler) {
	if v1 == nil {
		mux.HandleFunc("/v1/", notReady("v1 API"))
		mux.HandleFunc("/v1beta/", notReady("v1beta API"))
		return
	}
	if auth == nil {
		v1.Register(mux)
		return
	}
	submux := http.NewServeMux()
	v1.Register(submux)
	mux.Handle("/v1/", auth(submux))
	mux.Handle("/v1beta/", auth(submux))
}

// registerConsole wires the /console/ route group. A nil registrar leaves
// the prefix on the shared "not implemented" placeholder for the same
// reason as registerV1.
func registerConsole(mux *http.ServeMux, admin AdminRegistrar) {
	if admin == nil {
		mux.HandleFunc("/console/", notReady("console API"))
		return
	}
	admin.Register(mux)
}

// handleNotFound is the terminal 404 for any path not matched above. It
// is registered on "/" so ServeMux falls through to it last, preserving
// Go's longest-pattern-wins semantics for the route groups above.
func handleNotFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, "route not found")
}

// notReady is the 501 placeholder used while a route group is being built.
// It is intentionally shared by /v1/ and /console/ so both expose the
// same discoverable shape ("not implemented" + module tag) when their
// owning package is not yet wired.
func notReady(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeModuleError(w, http.StatusNotImplemented, "route is not implemented", name)
	}
}
