package apierrors

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func TestCodeConstants(t *testing.T) {
	cases := map[Code]string{
		CodeInvalidRequest:   "invalid_request",
		CodeMethodNotAllowed: "method_not_allowed",
		CodeNotFound:         "not_found",
		CodeNotImplemented:   "not_implemented",
		CodePayloadTooLarge:  "payload_too_large",
		CodeUnsupportedMedia: "unsupported_media_type",
		CodeAuthMissing:      "authentication_required",
		CodeUpstream:         "upstream_error",
		CodeInternal:         "internal_error",
		Kind:                 "error",
	}
	for code, want := range cases {
		if string(code) != want {
			t.Fatalf("%q != %q", code, want)
		}
	}
}

func TestErrorResponseJSONRoundTrip(t *testing.T) {
	in := Response{Error: Error{
		Kind:    Kind,
		Code:    CodeInvalidRequest,
		Message: "bad input",
		Param:   "model",
		Request: "req-1",
	}}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out Response
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out != in {
		t.Fatalf("round-trip mismatch: got %#v want %#v", out, in)
	}
	if !strings.Contains(string(raw), `"type":"error"`) || !strings.Contains(string(raw), `"code":"invalid_request"`) {
		t.Fatalf("unexpected json: %s", raw)
	}
}

func TestFromRouteError(t *testing.T) {
	t.Run("nil", func(t *testing.T) {
		status, body := FromRouteError(nil)
		if status != http.StatusInternalServerError || body.Error.Code != CodeInternal {
			t.Fatalf("got status=%d body=%#v", status, body)
		}
		if body.Error.Message != "internal error" {
			t.Fatalf("message=%q", body.Error.Message)
		}
	})

	t.Run("invalid request", func(t *testing.T) {
		status, body := FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorInvalidRequest,
			StatusCode: http.StatusUnprocessableEntity,
			Message:    "missing model",
		})
		if status != http.StatusUnprocessableEntity || body.Error.Code != CodeInvalidRequest {
			t.Fatalf("got status=%d body=%#v", status, body)
		}
		if body.Error.Kind != Kind || body.Error.Message != "missing model" {
			t.Fatalf("envelope=%#v", body.Error)
		}
	})

	t.Run("payload too large", func(t *testing.T) {
		status, body := FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorInvalidRequest,
			StatusCode: http.StatusRequestEntityTooLarge,
			Message:    "too big",
		})
		if status != http.StatusRequestEntityTooLarge || body.Error.Code != CodePayloadTooLarge {
			t.Fatalf("got status=%d body=%#v", status, body)
		}
		if body.Error.Kind != CodePayloadTooLarge {
			t.Fatalf("kind=%q", body.Error.Kind)
		}
	})

	t.Run("invalid request remaps status", func(t *testing.T) {
		status, body := FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorInvalidRequest,
			StatusCode: http.StatusOK,
			Message:    "bad",
		})
		if status != http.StatusBadRequest || body.Error.Code != CodeInvalidRequest {
			t.Fatalf("got status=%d body=%#v", status, body)
		}
	})

	t.Run("authentication", func(t *testing.T) {
		status, body := FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorAuthentication,
			StatusCode: http.StatusUnauthorized,
			Message:    "login required",
		})
		if status != http.StatusUnauthorized || body.Error.Code != CodeAuthMissing {
			t.Fatalf("got status=%d body=%#v", status, body)
		}
		status, body = FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorAuthentication,
			StatusCode: http.StatusBadRequest,
			Message:    "login required",
		})
		if status != http.StatusBadGateway || body.Error.Code != CodeAuthMissing {
			t.Fatalf("auth remap got status=%d body=%#v", status, body)
		}
	})

	t.Run("entitlement", func(t *testing.T) {
		status, body := FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorEntitlement,
			StatusCode: http.StatusForbidden,
			Message:    "no access",
		})
		if status != http.StatusForbidden || body.Error.Code != CodeUpstream {
			t.Fatalf("got status=%d body=%#v", status, body)
		}
		status, _ = FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorEntitlement,
			StatusCode: http.StatusOK,
			Message:    "no access",
		})
		if status != http.StatusBadGateway {
			t.Fatalf("entitlement remap status=%d", status)
		}
	})

	t.Run("rate limit and quota", func(t *testing.T) {
		for _, kind := range []contracts.ErrorKind{contracts.ErrorRateLimit, contracts.ErrorQuota} {
			status, body := FromRouteError(&contracts.RouteError{
				Kind:       kind,
				StatusCode: http.StatusTooManyRequests,
				Message:    "slow down",
			})
			if status != http.StatusTooManyRequests || body.Error.Code != CodeUpstream {
				t.Fatalf("kind %s: status=%d body=%#v", kind, status, body)
			}
			status, _ = FromRouteError(&contracts.RouteError{
				Kind:       kind,
				StatusCode: http.StatusOK,
				Message:    "slow down",
			})
			if status != http.StatusBadGateway {
				t.Fatalf("kind %s remap status=%d", kind, status)
			}
		}
	})

	t.Run("upstream kinds", func(t *testing.T) {
		kinds := []contracts.ErrorKind{
			contracts.ErrorUnsupported,
			contracts.ErrorTranslation,
			contracts.ErrorContentPolicy,
			contracts.ErrorReauthenticationRequired,
			contracts.ErrorCapacity,
			contracts.ErrorEmptyOutput,
			contracts.ErrorTransient,
			contracts.ErrorServerError,
			contracts.ErrorFatal,
		}
		for _, kind := range kinds {
			status, body := FromRouteError(&contracts.RouteError{
				Kind:       kind,
				StatusCode: http.StatusBadGateway,
				Message:    "upstream failed",
			})
			if status != http.StatusBadGateway || body.Error.Code != CodeUpstream {
				t.Fatalf("kind %s: status=%d body=%#v", kind, status, body)
			}
		}
	})

	t.Run("invalid status remapped", func(t *testing.T) {
		status, body := FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorFatal,
			StatusCode: 200,
			Message:    "oops",
		})
		if status != http.StatusBadGateway || body.Error.Code != CodeUpstream {
			t.Fatalf("got status=%d body=%#v", status, body)
		}
	})

	t.Run("namespaced code override", func(t *testing.T) {
		status, body := FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorFatal,
			StatusCode: http.StatusBadGateway,
			Code:       "provider.quota/exhausted",
			Message:    "quota gone",
		})
		if status != http.StatusBadGateway || body.Error.Code != Code("provider.quota/exhausted") {
			t.Fatalf("got status=%d body=%#v", status, body)
		}
	})

	t.Run("invalid namespaced codes ignored", func(t *testing.T) {
		for _, code := range []string{"", "nonsafe", "bad code", strings.Repeat("a", 97), "has space.", "emoji.💥"} {
			_, body := FromRouteError(&contracts.RouteError{
				Kind:       contracts.ErrorFatal,
				StatusCode: http.StatusBadGateway,
				Code:       code,
				Message:    "x",
			})
			if body.Error.Code != CodeUpstream {
				t.Fatalf("code %q produced %q", code, body.Error.Code)
			}
		}
	})

	t.Run("unsafe message falls back", func(t *testing.T) {
		_, body := FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorInvalidRequest,
			StatusCode: http.StatusBadRequest,
			Message:    "Authorization: Bearer secret",
		})
		if body.Error.Message != "invalid request" {
			t.Fatalf("message=%q", body.Error.Message)
		}
		_, body = FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorAuthentication,
			StatusCode: http.StatusUnauthorized,
			Message:    "",
		})
		if body.Error.Message != "authentication required" {
			t.Fatalf("message=%q", body.Error.Message)
		}
		_, body = FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorFatal,
			StatusCode: http.StatusBadGateway,
			Message:    strings.Repeat("x", 257),
		})
		if body.Error.Message != "upstream request failed" {
			t.Fatalf("message=%q", body.Error.Message)
		}
		_, body = FromRouteError(&contracts.RouteError{
			Kind:       contracts.ErrorFatal,
			StatusCode: http.StatusBadGateway,
			Message:    "bad\x00msg",
		})
		if body.Error.Message != "upstream request failed" {
			t.Fatalf("control message=%q", body.Error.Message)
		}
	})
}

func decodeEnvelope(t *testing.T, rec *httptest.ResponseRecorder) Response {
	t.Helper()
	var body Response
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	return body
}

func TestWrite(t *testing.T) {
	rec := httptest.NewRecorder()
	Write(rec, http.StatusBadRequest, CodeInvalidRequest, "bad field")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("content-type=%q", ct)
	}
	body := decodeEnvelope(t, rec)
	if body.Error.Code != CodeInvalidRequest || body.Error.Message != "bad field" || body.Error.Kind != Kind {
		t.Fatalf("body=%#v", body)
	}

	rec = httptest.NewRecorder()
	Write(rec, http.StatusOK, CodeInternal, "should become 500")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500", rec.Code)
	}

	rec = httptest.NewRecorder()
	Write(rec, http.StatusNotFound, CodeNotFound, "missing")
	body = decodeEnvelope(t, rec)
	if body.Error.Kind != CodeNotFound || body.Error.Code != CodeNotFound {
		t.Fatalf("kind/code=%#v", body.Error)
	}

	rec = httptest.NewRecorder()
	Write(rec, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "nope")
	body = decodeEnvelope(t, rec)
	if body.Error.Kind != CodeUnsupportedMedia {
		t.Fatalf("kind=%q", body.Error.Kind)
	}

	rec = httptest.NewRecorder()
	Write(rec, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "nope")
	body = decodeEnvelope(t, rec)
	if body.Error.Kind != CodeMethodNotAllowed {
		t.Fatalf("kind=%q", body.Error.Kind)
	}
}

func TestWriteError(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, nil)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("nil status=%d", rec.Code)
	}
	body := decodeEnvelope(t, rec)
	if body.Error.Code != CodeInternal {
		t.Fatalf("nil body=%#v", body)
	}

	rec = httptest.NewRecorder()
	WriteError(rec, errors.New("raw boom"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("unknown status=%d", rec.Code)
	}
	body = decodeEnvelope(t, rec)
	if body.Error.Code != CodeInternal || body.Error.Message != "internal error" {
		t.Fatalf("unknown body=%#v", body)
	}

	rec = httptest.NewRecorder()
	WriteError(rec, &contracts.RouteError{
		Kind:       contracts.ErrorInvalidRequest,
		StatusCode: http.StatusBadRequest,
		Message:    "bad json",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("route status=%d", rec.Code)
	}
	body = decodeEnvelope(t, rec)
	if body.Error.Code != CodeInvalidRequest || body.Error.Message != "bad json" {
		t.Fatalf("route body=%#v", body)
	}

	wrapped := errors.Join(errors.New("wrap"), &contracts.RouteError{
		Kind:       contracts.ErrorAuthentication,
		StatusCode: http.StatusUnauthorized,
		Message:    "need auth",
	})
	rec = httptest.NewRecorder()
	WriteError(rec, wrapped)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrapped status=%d", rec.Code)
	}
	body = decodeEnvelope(t, rec)
	if body.Error.Code != CodeAuthMissing {
		t.Fatalf("wrapped body=%#v", body)
	}
}

func TestMethodNotAllowedNotFoundNotImplemented(t *testing.T) {
	rec := httptest.NewRecorder()
	MethodNotAllowed(rec, "GET, POST")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d", rec.Code)
	}
	if rec.Header().Get("Allow") != "GET, POST" {
		t.Fatalf("Allow=%q", rec.Header().Get("Allow"))
	}
	body := decodeEnvelope(t, rec)
	if body.Error.Code != CodeMethodNotAllowed || body.Error.Kind != CodeMethodNotAllowed {
		t.Fatalf("body=%#v", body)
	}

	rec = httptest.NewRecorder()
	NotFound(rec, "route missing")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d", rec.Code)
	}
	body = decodeEnvelope(t, rec)
	if body.Error.Code != CodeNotFound || body.Error.Message != "route missing" {
		t.Fatalf("body=%#v", body)
	}

	rec = httptest.NewRecorder()
	NotImplemented(rec, "images")
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status=%d", rec.Code)
	}
	body = decodeEnvelope(t, rec)
	if body.Error.Code != CodeNotImplemented || body.Error.Message != "images is not implemented" {
		t.Fatalf("body=%#v", body)
	}
	if body.Error.Kind != Kind {
		t.Fatalf("kind=%q", body.Error.Kind)
	}
}
