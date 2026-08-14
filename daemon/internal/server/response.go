package server

import (
	"encoding/json"
	"net/http"
)

// ErrorResponse is the canonical JSON body returned for non-2xx outcomes.
// Every error in the foundation uses this shape so clients can rely on a
// single parser across /health, /metrics, /v1/, /v2/admin/, and the
// catch-all 404.
type ErrorResponse struct {
	Error   string `json:"error"`
	Module  string `json:"module,omitempty"`
	Request string `json:"request_id,omitempty"`
}

// writeJSON serializes value as JSON with the given status code and the
// foundation's content-type. Encoding errors are intentionally swallowed
// because by the time they surface the response status has already been
// committed; logging is delegated to the observability middleware.
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// writeError emits a bare ErrorResponse with the given status and message.
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, ErrorResponse{Error: message})
}

// writeModuleError emits an ErrorResponse tagged with the owning module.
// It is used by the "not implemented" placeholder so clients can tell
// which route group is missing.
func writeModuleError(w http.ResponseWriter, status int, message, module string) {
	writeJSON(w, status, ErrorResponse{Error: message, Module: module})
}

// writeMethodNotAllowed emits a 405 and sets the Allow header so clients
// can recover. The allowed argument is a single HTTP method or a
// comma-separated list, matching RFC 9110.
func writeMethodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
}
