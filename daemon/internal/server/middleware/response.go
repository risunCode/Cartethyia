package middleware

import (
	"encoding/json"
	"net/http"
)

// errorBody is the canonical error envelope written by the middleware
// helpers. Callers can extend it by setting additional headers before the
// write call.
type errorBody struct {
	Error string `json:"error"`
}

func writeError(w http.ResponseWriter, status int, message string) {
	if w == nil {
		return
	}
	h := w.Header()
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", "application/json")
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorBody{Error: message})
}
