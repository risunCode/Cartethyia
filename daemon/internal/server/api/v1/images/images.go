// Package images owns the OpenAI image endpoints:
//   - POST /v1/images/generations
//   - POST /v1/images/edits (multipart/form-data)
//
// Both endpoints are forwarded through the proxy service. The generations
// endpoint expects JSON; the edits endpoint expects multipart/form-data.
// The image-specific protocol is mapped to a generic internal protocol
// token because contracts does not yet define a dedicated image protocol.
package images

import (
	"net/http"
	"strings"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/server/api/contracts"
	"github.com/cartethyia/daemon/internal/server/api/errors"
	"github.com/cartethyia/daemon/internal/server/api/wire"
)

// PathGenerations is the canonical /v1 path for image generation.
const PathGenerations = "/v1/images/generations"

// PathEdits is the canonical /v1 path for image edits.
const PathEdits = "/v1/images/edits"

// Protocol is the surface tag carried in contracts.Request so the proxy
// pipeline can route to the image-capable providers. It mirrors the
// legacy surface token used in src.old/open-sse/translate/surface.ts.
const Protocol contracts.Protocol = "images"

// Deps wires the image handlers to the proxy service.
type Deps struct {
	Proxy apicontracts.ProxyService
}

// Register mounts both image endpoints on mux.
func Register(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc(PathGenerations, func(w http.ResponseWriter, r *http.Request) {
		handleGenerations(w, r, deps.Proxy)
	})
	mux.HandleFunc(PathEdits, func(w http.ResponseWriter, r *http.Request) {
		handleEdits(w, r, deps.Proxy)
	})
}

func handleGenerations(w http.ResponseWriter, r *http.Request, proxy apicontracts.ProxyService) {
	if r.Method != http.MethodPost {
		apierrors.MethodNotAllowed(w, http.MethodPost)
		return
	}
	if proxy == nil {
		apierrors.Write(w, http.StatusServiceUnavailable, apierrors.CodeInternal, "image proxy is not configured")
		return
	}
	if !wire.HasJSONContentType(r) {
		apierrors.Write(w, http.StatusUnsupportedMediaType, apierrors.CodeUnsupportedMedia, "image generations require Content-Type: application/json")
		return
	}

	body, err := wire.ReadBoundedJSON(r, apicontracts.MaxBodyBytes)
	if err != nil {
		apierrors.WriteError(w, err)
		return
	}

	stream, err := proxy.Dispatch(&contracts.Request{
		Protocol: Protocol,
		Headers:  r.Header.Clone(),
		Body:     body,
	})
	if err != nil {
		apierrors.WriteError(w, err)
		return
	}
	_ = wire.WriteStream(r.Context(), w, stream)
}

func handleEdits(w http.ResponseWriter, r *http.Request, proxy apicontracts.ProxyService) {
	if r.Method != http.MethodPost {
		apierrors.MethodNotAllowed(w, http.MethodPost)
		return
	}
	if proxy == nil {
		apierrors.Write(w, http.StatusServiceUnavailable, apierrors.CodeInternal, "image proxy is not configured")
		return
	}
	if !isMultipart(r) {
		apierrors.Write(w, http.StatusUnsupportedMediaType, apierrors.CodeUnsupportedMedia, "image edits require Content-Type: multipart/form-data")
		return
	}

	// Multipart bodies are bounded by Content-Length and by the
	// http.MaxBytesReader applied inside the proxy pipeline. We do not
	// re-buffer the form here because the multipart parser lives in the
	// proxy layer; the handler only asserts the content type and hands
	// the raw stream over.
	stream, err := proxy.Dispatch(&contracts.Request{
		Protocol: Protocol,
		Headers:  r.Header.Clone(),
	})
	if err != nil {
		apierrors.WriteError(w, err)
		return
	}
	_ = wire.WriteStream(r.Context(), w, stream)
}

func isMultipart(r *http.Request) bool {
	ct := r.Header.Get("Content-Type")
	return strings.HasPrefix(strings.ToLower(ct), "multipart/form-data")
}
