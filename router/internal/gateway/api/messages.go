// Package messages owns POST /v1/messages. It is the Anthropic Messages
// surface, mapped to contracts.ProtocolAnthropic.
package api

import (
	"net/http"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// Path is the canonical /v1 path for Anthropic messages.
const MessagesPath = "/v1/messages"

// Deps wires the messages handler to the proxy service.
// Register mounts POST /v1/messages on mux.
func registerMessages(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc(MessagesPath+"/count_tokens", func(w http.ResponseWriter, r *http.Request) {
		handleCountTokens(w, r)
	})
	mux.HandleFunc(MessagesPath, func(w http.ResponseWriter, r *http.Request) {
		handleMessages(w, r, deps.Proxy)
	})
}

func handleMessages(w http.ResponseWriter, r *http.Request, proxy ProxyService) {
	if r.Method != http.MethodPost {
		MethodNotAllowed(w, http.MethodPost)
		return
	}
	if proxy == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "anthropic proxy is not configured")
		return
	}
	if !HasJSONContentType(r) {
		Write(w, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "messages require Content-Type: application/json")
		return
	}

	body, err := ReadBoundedJSON(r, MaxBodyBytes)
	if err != nil {
		WriteError(w, err)
		return
	}

	req := &contracts.Request{
		Protocol: contracts.ProtocolAnthropic,
		Headers:  r.Header.Clone(),
		Body:     body,
		Stream:   StreamRequested(body),
	}

	dispatchCtx, profileErr := contracts.AttachProfile(r.Context(), contracts.ClassificationInput{
		Endpoint: MessagesPath,
		Surface:  contracts.SurfaceAnthropic,
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
