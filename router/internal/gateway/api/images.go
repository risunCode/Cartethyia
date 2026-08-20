// Package images owns the OpenAI image endpoints:
//   - POST /v1/images/generations
//   - POST /v1/images/edits (multipart/form-data)
//
// Both endpoints are forwarded through the proxy service. The generations
// endpoint expects JSON; the edits endpoint expects multipart/form-data. Both
// use the canonical image surface so catalog routing remains explicit.
package api

import (
	"net/http"
	"strings"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// PathGenerations is the canonical /v1 path for image generation.
const PathGenerations = "/v1/images/generations"

// PathEdits is the canonical /v1 path for image edits.
const PathEdits = "/v1/images/edits"

// Protocol is the surface tag carried in contracts.Request so the proxy
// pipeline can route to image-capable providers.
const Protocol contracts.Protocol = "images"

// Deps wires the image handlers to the proxy service.
// Register mounts both image endpoints on mux.
func registerImages(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc(PathGenerations, func(w http.ResponseWriter, r *http.Request) {
		handleImageGenerations(w, r, deps.Proxy)
	})
	mux.HandleFunc(PathEdits, func(w http.ResponseWriter, r *http.Request) {
		handleImageEdits(w, r, deps.Proxy)
	})
}

func handleImageGenerations(w http.ResponseWriter, r *http.Request, proxy ProxyService) {
	if r.Method != http.MethodPost {
		MethodNotAllowed(w, http.MethodPost)
		return
	}
	if proxy == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "image proxy is not configured")
		return
	}
	if !HasJSONContentType(r) {
		Write(w, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "image generations require Content-Type: application/json")
		return
	}

	body, err := ReadBoundedJSON(r, MaxBodyBytes)
	if err != nil {
		WriteError(w, err)
		return
	}

	stream, err := DispatchContext(r.Context(), proxy, &contracts.Request{
		Protocol: Protocol,
		Headers:  r.Header.Clone(),
		Body:     body,
	})
	if err != nil {
		WriteError(w, err)
		return
	}
	_ = WriteStream(r.Context(), w, stream)
}

func handleImageEdits(w http.ResponseWriter, r *http.Request, proxy ProxyService) {
	if r.Method != http.MethodPost {
		MethodNotAllowed(w, http.MethodPost)
		return
	}
	if proxy == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "image proxy is not configured")
		return
	}
	if !isMultipart(r) {
		Write(w, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "image edits require Content-Type: multipart/form-data")
		return
	}

	// Multipart bodies are bounded by Content-Length and by the
	// http.MaxBytesReader applied inside the proxy pipeline. We do not
	// re-buffer the form here because the multipart parser lives in the
	// proxy layer; the handler only asserts the content type and hands
	// the raw stream over.
	stream, err := DispatchContext(r.Context(), proxy, &contracts.Request{
		Protocol: Protocol,
		Headers:  r.Header.Clone(),
	})
	if err != nil {
		WriteError(w, err)
		return
	}
	_ = WriteStream(r.Context(), w, stream)
}

func isMultipart(r *http.Request) bool {
	ct := r.Header.Get("Content-Type")
	return strings.HasPrefix(strings.ToLower(ct), "multipart/form-data")
}
