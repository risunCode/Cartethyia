// Package responses owns POST /v1/responses. It is the OpenAI Responses
// surface, mapped to contracts.ProtocolOpenAIResponse.
package api

import (
	"net/http"

	contracts "github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/gateway/middleware"
)

// Path is the canonical /v1 path for OpenAI Responses.
const ResponsesPath = "/v1/responses"

// Deps wires the responses handler to the proxy service.
// Register mounts POST /v1/responses on mux.
func registerResponses(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc(ResponsesPath, func(w http.ResponseWriter, r *http.Request) {
		handleResponses(w, r, deps.Proxy)
	})
}

func handleResponses(w http.ResponseWriter, r *http.Request, proxy ProxyService) {
	if r.Method != http.MethodPost {
		MethodNotAllowed(w, http.MethodPost)
		return
	}
	if proxy == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "responses proxy is not configured")
		return
	}
	if !HasJSONContentType(r) {
		Write(w, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "responses require Content-Type: application/json")
		return
	}

	body, err := ReadBoundedJSON(r, MaxBodyBytes)
	if err != nil {
		WriteError(w, err)
		return
	}

	req := &contracts.Request{
		Protocol:          contracts.ProtocolOpenAIResponse,
		Headers:           r.Header.Clone(),
		Body:              body,
		Stream:            StreamRequested(body),
		ContinuationScope: middleware.PublicAPIKeyIDFrom(r.Context()),
	}

	dispatchCtx, profileErr := contracts.AttachProfile(r.Context(), contracts.ClassificationInput{
		Endpoint: ResponsesPath,
		Surface:  contracts.SurfaceOpenAIResponses,
		Headers:  r.Header,
		Body:     body,
	})
	if profileErr != nil {
		Write(w, http.StatusInternalServerError, CodeInternal, "request profile classification failed")
		return
	}
	stream, err := DispatchContext(dispatchCtx, proxy, req)
	if err != nil {
		WriteError(w, err)
		return
	}
	_ = WriteStream(r.Context(), w, stream)
}
