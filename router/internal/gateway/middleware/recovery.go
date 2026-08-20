package middleware

import (
	"encoding/json"
	"fmt"
	"net/http"
	"runtime/debug"

	"github.com/cartethyia/daemon/internal/telemetry"
)

// recoveryErrorBody mirrors the daemon's canonical nested error envelope
// (the shape admin.WriteError and apierrors both emit) so a recovered panic
// is indistinguishable from any other structured internal failure.
type recoveryErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type recoveryErrorResponse struct {
	Error recoveryErrorBody `json:"error"`
}

// Recovery converts downstream handler panics into the daemon's JSON error
// envelope instead of letting the net/http server abort the connection
// without a response. It must wrap the full handler chain (directly inside
// RequestID) so every route — including streaming handlers that re-panic
// after enqueue failure metadata — still receives an error envelope.
//
// The panic value and stack are recorded through the registry's structured
// logger; the client only ever sees the generic internal-error body.
// http.ErrAbortHandler is re-panicked per net/http convention: it signals an
// intentional connection abort, not a handler defect.
func Recovery(log telemetry.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			if rec == http.ErrAbortHandler {
				panic(rec)
			}
			if log != nil {
				log.Error(r.Context(), "http handler panic",
					telemetry.Any("panic", fmt.Sprint(rec)),
					telemetry.String("stack", string(debug.Stack())),
					telemetry.String("method", r.Method),
					telemetry.String("path", r.URL.Path),
				)
			}
			writeRecoveryError(w, r)
		}()
		next.ServeHTTP(w, r)
	})
}

// writeRecoveryError emits the 500 envelope. When the request-ID middleware
// already ran its identifier survives on the response headers; the explicit
// re-set keeps the correlation header present even when Recovery is mounted
// without RequestID.
func writeRecoveryError(w http.ResponseWriter, r *http.Request) {
	if w == nil {
		return
	}
	header := w.Header()
	if header.Get(HeaderRequestID) == "" {
		if id := r.Header.Get(HeaderRequestID); id != "" {
			header.Set(HeaderRequestID, id)
		}
	}
	if header.Get("Content-Type") == "" {
		header.Set("Content-Type", "application/json")
	}
	w.WriteHeader(http.StatusInternalServerError)
	_ = json.NewEncoder(w).Encode(recoveryErrorResponse{Error: recoveryErrorBody{
		Code:    "internal_error",
		Message: "internal server error",
	}})
}
