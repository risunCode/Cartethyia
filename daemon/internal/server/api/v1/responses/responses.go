// Package responses owns POST /v1/responses. It is the OpenAI Responses
// surface, mapped to contracts.ProtocolOpenAIResponse.
package responses

import (
	"net/http"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/server/api/contracts"
	"github.com/cartethyia/daemon/internal/server/api/errors"
	"github.com/cartethyia/daemon/internal/server/api/wire"
)

// Path is the canonical /v1 path for OpenAI Responses.
const Path = "/v1/responses"

// Deps wires the responses handler to the proxy service.
type Deps struct {
	Proxy apicontracts.ProxyService
}

// Register mounts POST /v1/responses on mux.
func Register(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc(Path, func(w http.ResponseWriter, r *http.Request) {
		handle(w, r, deps.Proxy)
	})
}

func handle(w http.ResponseWriter, r *http.Request, proxy apicontracts.ProxyService) {
	if r.Method != http.MethodPost {
		apierrors.MethodNotAllowed(w, http.MethodPost)
		return
	}
	if proxy == nil {
		apierrors.Write(w, http.StatusServiceUnavailable, apierrors.CodeInternal, "responses proxy is not configured")
		return
	}
	if !wire.HasJSONContentType(r) {
		apierrors.Write(w, http.StatusUnsupportedMediaType, apierrors.CodeUnsupportedMedia, "responses require Content-Type: application/json")
		return
	}

	body, err := wire.ReadBoundedJSON(r, apicontracts.MaxBodyBytes)
	if err != nil {
		apierrors.WriteError(w, err)
		return
	}

	req := &contracts.Request{
		Protocol: contracts.ProtocolOpenAIResponse,
		Headers:  r.Header.Clone(),
		Body:     body,
		Stream:   wire.StreamRequested(body),
	}

	stream, err := apicontracts.DispatchContext(r.Context(), proxy, req)
	if err != nil {
		apierrors.WriteError(w, err)
		return
	}
	_ = wire.WriteStream(r.Context(), w, stream)
}
