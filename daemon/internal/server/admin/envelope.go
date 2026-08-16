// Package admin hosts the /console HTTP boundary for Cartethyia.
//
// The package is the centralized, source-clear composition of the dashboard,
// account, API key, proxy, settings, backup, tools, auth/session, and telemetry
// surfaces. It defines narrow service interfaces and consistent JSON
// envelope/error helpers, and exposes a single composable registration
// function. Handlers MUST NOT start listeners, MUST NOT import provider or
// storage globals, and MUST NOT register non-standard HTTP methods.
package admin

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// ContentType is the canonical JSON content type emitted by every handler.
const ContentType = "application/json; charset=utf-8"

// ErrorCode is the stable, machine-readable identifier returned in error
// envelopes. It is intentionally short and lower-snake-case so the dashboard
// can dispatch on it without parsing the human-readable message.
type ErrorCode string

const (
	CodeOK             ErrorCode = "ok"
	CodeInvalidRequest ErrorCode = "invalid_request"
	CodeAuthentication ErrorCode = "authentication"
	CodeForbidden      ErrorCode = "forbidden"
	CodeNotFound       ErrorCode = "not_found"
	CodeConflict       ErrorCode = "conflict"
	CodeRateLimited    ErrorCode = "rate_limited"
	CodeUnavailable    ErrorCode = "unavailable"
	CodeInternal       ErrorCode = "internal_error"
)

// Error is a structured error that handlers return to the envelope layer.
// It deliberately mirrors the legacy console error shape so the dashboard can
// remain agnostic to the transport rewrite.
type Error struct {
	Code    ErrorCode
	Message string
	Details map[string]any
	Cause   error
}

// Error implements error without serializing the wrapped cause. Causes remain
// available through Unwrap for internal classification, but their text may
// contain credentials or raw upstream bodies and is never operator-safe.
func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Unwrap exposes the underlying cause for errors.Is/As.
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// WithCause attaches a wrapping cause to the error and returns a copy.
func (e *Error) WithCause(cause error) *Error {
	if e == nil {
		return nil
	}
	clone := *e
	clone.Cause = cause
	return &clone
}

// WithDetails returns a copy of the error with structured details attached.
func (e *Error) WithDetails(details map[string]any) *Error {
	if e == nil {
		return nil
	}
	clone := *e
	if len(details) > 0 {
		clone.Details = make(map[string]any, len(details))
		for k, v := range details {
			clone.Details[k] = v
		}
	}
	return &clone
}

// NewError builds a structured admin error.
func NewError(code ErrorCode, message string) *Error {
	return &Error{Code: code, Message: message}
}

// Wrap attaches a cause to an error without losing the code/message.
func Wrap(code ErrorCode, message string, cause error) *Error {
	return &Error{Code: code, Message: message, Cause: cause}
}

// envelope is the wire shape returned by every handler. The `data` field is
// populated on success; `error` is populated on failure. The two fields are
// mutually exclusive so clients can branch on presence.
type envelope struct {
	Data  any           `json:"data,omitempty"`
	Error *errorBody    `json:"error,omitempty"`
	Meta  *envelopeMeta `json:"meta,omitempty"`
}

type errorBody struct {
	Code    ErrorCode      `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

type envelopeMeta struct {
	RequestID string `json:"request_id,omitempty"`
}

// WriteData encodes the value as a success envelope and writes it.
func WriteData(w http.ResponseWriter, status int, data any) {
	writeEnvelope(w, status, envelope{Data: data})
}

// WriteDataRequest writes a success envelope and includes the inbound request
// identifier when the request-ID middleware or caller supplied one.
func WriteDataRequest(w http.ResponseWriter, r *http.Request, status int, data any) {
	var meta *envelopeMeta
	if r != nil {
		if id := strings.TrimSpace(r.Header.Get("X-Request-Id")); id != "" {
			meta = &envelopeMeta{RequestID: id}
		}
	}
	writeEnvelope(w, status, envelope{Data: data, Meta: meta})
}

// WriteOK writes a standardized "ok" response with an optional payload.
func WriteOK(w http.ResponseWriter, payload ...any) {
	if len(payload) == 0 {
		writeEnvelope(w, http.StatusOK, envelope{Data: map[string]any{"ok": true}})
		return
	}
	if len(payload) == 1 {
		writeEnvelope(w, http.StatusOK, envelope{Data: payload[0]})
		return
	}
	merged := make(map[string]any, len(payload))
	merged["ok"] = true
	for _, item := range payload {
		if m, ok := item.(map[string]any); ok {
			for k, v := range m {
				merged[k] = v
			}
		}
	}
	writeEnvelope(w, http.StatusOK, envelope{Data: merged})
}

// WriteError translates an error into a structured envelope. It maps known
// admin error codes to HTTP statuses. Unknown errors receive a generic
// internal message so wrapped provider/transport details cannot cross the
// operator API boundary.
func WriteError(w http.ResponseWriter, err error) {
	if err == nil {
		WriteOK(w)
		return
	}

	var adminErr *Error
	if !errors.As(err, &adminErr) {
		writeEnvelope(w, http.StatusInternalServerError, envelope{Error: &errorBody{
			Code:    CodeInternal,
			Message: "internal server error",
		}})
		return
	}

	message := safeOperatorMessage(adminErr.Code, adminErr.Message)
	writeEnvelope(w, statusFor(adminErr.Code), envelope{Error: &errorBody{
		Code:    adminErr.Code,
		Message: message,
		Details: safeOperatorDetails(adminErr.Details),
	}})
}

func safeOperatorMessage(code ErrorCode, message string) string {
	if containsOperatorSecret(message) {
		if code == CodeInternal {
			return "internal server error"
		}
		return "request failed"
	}
	return message
}

func containsOperatorSecret(value string) bool {
	lower := strings.ToLower(value)
	for _, marker := range []string{
		"authorization", "api_key", "apikey", "access_token", "refresh_token",
		"client_secret", "password=", "credential=", "secret=", "token=",
		"bearer ", "cookie=", "\"messages\"", "\"body\"",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func safeOperatorDetails(details map[string]any) map[string]any {
	if len(details) == 0 {
		return nil
	}
	out := make(map[string]any, len(details))
	for key, value := range details {
		if containsOperatorSecret(key) {
			out[key] = "[REDACTED]"
			continue
		}
		out[key] = safeOperatorValue(value)
	}
	return out
}

func safeOperatorValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return safeOperatorDetails(typed)
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = safeOperatorValue(item)
		}
		return out
	case string:
		if containsOperatorSecret(typed) {
			return "[REDACTED]"
		}
	}
	return value
}

// WriteStatus writes a status envelope without a body, useful for endpoints
// that return only a status code (e.g. health, liveness).
func WriteStatus(w http.ResponseWriter, status int) {
	w.Header().Set("Content-Type", ContentType)
	w.WriteHeader(status)
}

// statusFor maps an admin error code to its HTTP status. Centralized so every
// handler returns identical status semantics.
func statusFor(code ErrorCode) int {
	switch code {
	case CodeInvalidRequest, CodeAdminInvalidRequest:
		return http.StatusBadRequest
	case CodeAuthentication, CodeAdminAuthentication:
		return http.StatusUnauthorized
	case CodeForbidden, CodeAdminForbidden:
		return http.StatusForbidden
	case CodeNotFound:
		return http.StatusNotFound
	case CodeConflict:
		return http.StatusConflict
	case CodeRateLimited:
		return http.StatusTooManyRequests
	case CodeUnavailable, CodeAdminUnavailable:
		return http.StatusServiceUnavailable
	case CodeOK:
		return http.StatusOK
	default:
		return http.StatusInternalServerError
	}
}

func writeEnvelope(w http.ResponseWriter, status int, env envelope) {
	w.Header().Set("Content-Type", ContentType)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(env)
}

// allowedMethodsString formats a comma-separated Allow header value. Empty
// input returns an empty string, which signals "no methods allowed".
func allowedMethodsString(methods ...string) string {
	cleaned := make([]string, 0, len(methods))
	for _, m := range methods {
		m = strings.TrimSpace(m)
		if m != "" {
			cleaned = append(cleaned, m)
		}
	}
	return strings.Join(cleaned, ", ")
}
