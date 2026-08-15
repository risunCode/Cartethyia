// Package chat owns POST /v1/chat/completions. It is the OpenAI chat
// completions surface, mapped to contracts.ProtocolOpenAIChat.
package api

import (
	"net/http"

	"github.com/cartethyia/daemon/internal/proxy/protocol/compatibility"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// Path is the canonical /v1 path for chat completions.
const ChatPath = "/v1/chat/completions"

// Deps wires the chat handler to the proxy service.
// Register mounts POST /v1/chat/completions on mux.
func registerChat(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc(ChatPath, func(w http.ResponseWriter, r *http.Request) {
		handleChat(w, r, deps.Proxy)
	})
}

func handleChat(w http.ResponseWriter, r *http.Request, proxy ProxyService) {
	if r.Method != http.MethodPost {
		MethodNotAllowed(w, http.MethodPost)
		return
	}
	if proxy == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "chat proxy is not configured")
		return
	}
	if !HasJSONContentType(r) {
		Write(w, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "chat completions require Content-Type: application/json")
		return
	}

	body, err := ReadBoundedJSON(r, MaxBodyBytes)
	if err != nil {
		WriteError(w, err)
		return
	}

	req := &contracts.Request{
		Protocol: contracts.ProtocolOpenAIChat,
		Headers:  r.Header.Clone(),
		Body:     body,
		Stream:   StreamRequested(body),
	}

	dispatchCtx, profileErr := compatibility.AttachProfile(r.Context(), compatibility.ClassificationInput{
		Endpoint: ChatPath,
		Surface:  contracts.SurfaceOpenAIChat,
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
