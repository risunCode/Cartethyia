// Package gemini owns the native Gemini generateContent HTTP surface.
package api

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/cartethyia/daemon/internal/proxy/protocol/compatibility"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/server/middleware"
)

const (
	// PathPrefix is the native Gemini REST route prefix. The model and action
	// are encoded in the final path segment, as in the public Gemini API.
	PathPrefix = "/v1beta/models/"
	// Path is retained as the package's canonical route identifier for callers
	// that use the same convention as the other V1 endpoint packages.
	GeminiPath = PathPrefix

	generateAction       = ":generateContent"
	streamGenerateAction = ":streamGenerateContent"
)

// Register mounts the native Gemini generateContent routes on mux. A prefix
// handler is used because the model is part of the final path segment and Go's
// ServeMux patterns do not support a suffix after a named wildcard.
func registerGemini(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc(PathPrefix, func(w http.ResponseWriter, r *http.Request) {
		handleGemini(w, r, deps.Proxy)
	})
}

type routeAction uint8

const (
	actionInvalid routeAction = iota
	actionGenerate
	actionStreamGenerate
)

func handleGemini(w http.ResponseWriter, r *http.Request, proxy ProxyService) {
	model, action, ok := parsePath(r.URL.Path)
	if !ok {
		NotFound(w, "no Gemini route registered for "+r.URL.Path)
		return
	}
	if r.Method != http.MethodPost {
		MethodNotAllowed(w, http.MethodPost)
		return
	}
	if proxy == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "Gemini proxy is not configured")
		return
	}
	if !HasJSONContentType(r) {
		Write(w, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "Gemini generateContent requires Content-Type: application/json")
		return
	}

	body, err := ReadBoundedJSON(r, MaxBodyBytes)
	if err != nil {
		WriteError(w, err)
		return
	}

	stream := action == actionStreamGenerate
	req := &contracts.Request{
		Protocol:          contracts.ProtocolGemini,
		Model:             model,
		Headers:           r.Header.Clone(),
		Body:              body,
		Stream:            stream,
		ContinuationScope: middleware.PublicAPIKeyIDFrom(r.Context()),
	}

	dispatchCtx, profileErr := compatibility.AttachProfile(r.Context(), compatibility.ClassificationInput{
		Endpoint: r.URL.Path,
		Surface:  contracts.SurfaceGemini,
		Headers:  r.Header,
		Body:     body,
	})
	if profileErr != nil {
		Write(w, http.StatusInternalServerError, CodeInternal, "request profile classification failed")
		return
	}
	streamResponse, dispatchErr := DispatchContext(dispatchCtx, proxy, req)
	if dispatchErr != nil {
		WriteError(w, dispatchErr)
		return
	}
	_ = WriteStream(r.Context(), w, streamResponse)
}

func parsePath(path string) (string, routeAction, bool) {
	if !strings.HasPrefix(path, PathPrefix) {
		return "", actionInvalid, false
	}
	rest := strings.TrimPrefix(path, PathPrefix)
	action := actionInvalid
	switch {
	case strings.HasSuffix(rest, streamGenerateAction):
		action = actionStreamGenerate
		rest = strings.TrimSuffix(rest, streamGenerateAction)
	case strings.HasSuffix(rest, generateAction):
		action = actionGenerate
		rest = strings.TrimSuffix(rest, generateAction)
	default:
		return "", actionInvalid, false
	}
	if rest == "" || strings.ContainsRune(rest, '/') {
		return "", actionInvalid, false
	}
	model, err := url.PathUnescape(rest)
	if err != nil || model == "" || len(model) > contracts.MaxIdentifierBytes || strings.IndexFunc(model, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return "", actionInvalid, false
	}
	return model, action, true
}
