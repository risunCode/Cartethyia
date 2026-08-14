// Package chat owns POST /v1/chat/completions. It is the OpenAI chat
// completions surface, mapped to contracts.ProtocolOpenAIChat.
package chat

import (
	"net/http"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/server/api/contracts"
	"github.com/cartethyia/daemon/internal/server/api/errors"
	"github.com/cartethyia/daemon/internal/server/api/wire"
)

// Path is the canonical /v1 path for chat completions.
const Path = "/v1/chat/completions"

// Deps wires the chat handler to the proxy service.
type Deps struct {
	Proxy apicontracts.ProxyService
}

// Register mounts POST /v1/chat/completions on mux.
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
		apierrors.Write(w, http.StatusServiceUnavailable, apierrors.CodeInternal, "chat proxy is not configured")
		return
	}
	if !wire.HasJSONContentType(r) {
		apierrors.Write(w, http.StatusUnsupportedMediaType, apierrors.CodeUnsupportedMedia, "chat completions require Content-Type: application/json")
		return
	}

	body, err := wire.ReadBoundedJSON(r, apicontracts.MaxBodyBytes)
	if err != nil {
		apierrors.WriteError(w, err)
		return
	}

	req := &contracts.Request{
		Protocol: contracts.ProtocolOpenAIChat,
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
