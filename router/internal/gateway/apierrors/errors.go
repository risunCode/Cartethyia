// Package apierrors defines the consistent JSON error envelope returned by
// the Cartethyia /v1 API surface.
//
// Handlers in internal/gateway/api/* use this package for every non-2xx response.
// The shape stays compact so SDKs and CLI tooling can match stable codes.
package apierrors

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// Code is a stable, machine-readable failure identifier. The same code is
// surfaced across chat/messages/responses/models/images so callers can build
// a single switch statement regardless of endpoint.
type Code string

const (
	CodeInvalidRequest   Code = "invalid_request"
	CodeMethodNotAllowed Code = "method_not_allowed"
	CodeNotFound         Code = "not_found"
	CodeNotImplemented   Code = "not_implemented"
	CodePayloadTooLarge  Code = "payload_too_large"
	CodeUnsupportedMedia Code = "unsupported_media_type"
	CodeAuthMissing      Code = "authentication_required"
	CodeUpstream         Code = "upstream_error"
	CodeInternal         Code = "internal_error"
)

// Kind is the OpenAI-style top-level category. It is preserved in the wire
// payload so clients that expect `type: "error"` keep working.
const Kind = "error"

// Error is the JSON body returned for every non-2xx response.
type Error struct {
	Kind    Code   `json:"type"`
	Code    Code   `json:"code"`
	Message string `json:"message"`
	Param   string `json:"param,omitempty"`
	Request string `json:"request_id,omitempty"`
}

// Response wraps Error so we can grow metadata without breaking parsers
// that already key on `error.type` / `error.code`.
type Response struct {
	Error Error `json:"error"`
}

// FromRouteError maps a contracts.RouteError onto the JSON envelope while
func FromRouteError(routeErr *contracts.RouteError) (int, Response) {
	if routeErr == nil {
		return http.StatusInternalServerError, Response{Error: Error{
			Kind: kindFor(CodeInternal), Code: CodeInternal, Message: publicFallback(CodeInternal),
		}}
	}
	status := routeErr.StatusCode
	if status < 400 || status > 599 {
		status = http.StatusBadGateway
	}
	code := CodeUpstream
	switch routeErr.Kind {
	case contracts.ErrorInvalidRequest:
		code = CodeInvalidRequest
		if status == http.StatusRequestEntityTooLarge {
			code = CodePayloadTooLarge
		} else if status < 400 || status > 499 {
			status = http.StatusBadRequest
		}
	case contracts.ErrorAuthentication:
		code = CodeAuthMissing
		if status != http.StatusUnauthorized && status != http.StatusForbidden {
			status = http.StatusBadGateway
		}
	case contracts.ErrorEntitlement:
		code = CodeUpstream
		if status != http.StatusForbidden {
			status = http.StatusBadGateway
		}
	case contracts.ErrorRateLimit, contracts.ErrorQuota:
		code = CodeUpstream
		if status != http.StatusTooManyRequests && status != http.StatusForbidden {
			status = http.StatusBadGateway
		}
	case contracts.ErrorUnsupported, contracts.ErrorTranslation,
		contracts.ErrorContentPolicy, contracts.ErrorReauthenticationRequired,
		contracts.ErrorCapacity, contracts.ErrorEmptyOutput,
		contracts.ErrorTransient, contracts.ErrorServerError, contracts.ErrorFatal:
		code = CodeUpstream
	}
	if validNamespacedCode(routeErr.Code) {
		code = Code(routeErr.Code)
	}
	return status, Response{Error: Error{
		Kind:    kindFor(code),
		Code:    code,
		Message: safeMessage(routeErr.Message, code),
	}}
}

func kindFor(code Code) Code {
	switch code {
	case CodeMethodNotAllowed, CodeNotFound, CodePayloadTooLarge, CodeUnsupportedMedia:
		return code
	}
	return Kind
}

const maxPublicMessageBytes = 256

func validNamespacedCode(value string) bool {
	if len(value) == 0 || len(value) > 96 {
		return false
	}
	namespaced := false
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-', r == '.', r == '/':
			if r == '.' || r == '/' {
				namespaced = true
			}
		default:
			return false
		}
	}
	return namespaced
}

func safeMessage(message string, code Code) string {
	if len(message) == 0 || len(message) > maxPublicMessageBytes {
		return publicFallback(code)
	}
	lower := strings.ToLower(message)
	for _, marker := range []string{"authorization", "api_key", "access_token", "refresh_token", "client_secret", "password=", "secret=", "bearer ", "cookie="} {
		if strings.Contains(lower, marker) {
			return publicFallback(code)
		}
	}
	if strings.IndexFunc(message, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return publicFallback(code)
	}
	return message
}

func publicFallback(code Code) string {
	switch code {
	case CodeInvalidRequest:
		return "invalid request"
	case CodeAuthMissing:
		return "authentication required"
	case CodeUpstream:
		return "upstream request failed"
	default:
		return "internal error"
	}
}

// Write renders the envelope to w with the supplied status code. The
// Content-Type header is always set to application/json; callers should not
// have already written a status.
func Write(w http.ResponseWriter, status int, code Code, message string) {
	body := Response{Error: Error{
		Kind:    kindFor(code),
		Code:    code,
		Message: safeMessage(message, code),
	}}
	if status < 400 {
		status = http.StatusInternalServerError
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// WriteError inspects err and renders only typed, stable metadata. Unknown
// causes always receive a generic public message; the cause remains log-only.
func WriteError(w http.ResponseWriter, err error) {
	if err == nil {
		Write(w, http.StatusInternalServerError, CodeInternal, "unknown error")
		return
	}
	var routeErr *contracts.RouteError
	if errors.As(err, &routeErr) {
		status, body := FromRouteError(routeErr)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
		return
	}
	Write(w, http.StatusInternalServerError, CodeInternal, publicFallback(CodeInternal))
}

// MethodNotAllowed emits a 405 response with the supplied Allow header.
func MethodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	Write(w, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "method not allowed")
}

// NotFound emits a 404 with the standard envelope.
func NotFound(w http.ResponseWriter, message string) {
	Write(w, http.StatusNotFound, CodeNotFound, message)
}

// NotImplemented emits a 501 with the supplied module identifier.
func NotImplemented(w http.ResponseWriter, module string) {
	Write(w, http.StatusNotImplemented, CodeNotImplemented, fmt.Sprintf("%s is not implemented", module))
}
