package admin

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSecurityVerificationDoesNotSerializeUnknownCause(t *testing.T) {
	const secret = "sk-live-admin-secret"
	recorder := httptest.NewRecorder()
	WriteError(recorder, errors.New("upstream authorization Bearer "+secret))

	if recorder.Code != 500 {
		t.Fatalf("status=%d, want 500", recorder.Code)
	}
	var envelope struct {
		Error struct {
			Code    ErrorCode `json:"code"`
			Message string    `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("invalid error envelope: %v", err)
	}
	if envelope.Error.Code != CodeInternal {
		t.Fatalf("code=%q, want %q", envelope.Error.Code, CodeInternal)
	}
	if envelope.Error.Message == "" || strings.Contains(envelope.Error.Message, secret) {
		t.Fatalf("internal error message leaked secret: %q", envelope.Error.Message)
	}
}

func TestSecurityVerificationAdminErrorStringOmitsCause(t *testing.T) {
	const secret = "sk-live-admin-secret"
	err := Wrap(CodeInternal, "provider request failed", errors.New("authorization Bearer "+secret))
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("admin error string leaked cause: %q", err.Error())
	}
	if !errors.Is(err, err.Cause) {
		t.Fatal("admin error no longer unwraps its cause")
	}
}

func TestSecurityVerificationAdminErrorCodesHaveStableStatuses(t *testing.T) {
	for _, test := range []struct {
		code ErrorCode
		want int
	}{
		{CodeAdminAuthentication, 401},
		{CodeAdminForbidden, 403},
		{CodeAdminInvalidRequest, 400},
		{CodeAdminUnavailable, 503},
	} {
		recorder := httptest.NewRecorder()
		WriteError(recorder, NewError(test.code, "safe"))
		if recorder.Code != test.want {
			t.Errorf("code=%q status=%d, want %d", test.code, recorder.Code, test.want)
		}
	}
}

func TestSecurityVerificationDoesNotSerializeSecretBearingAdminMessage(t *testing.T) {
	const secret = "sk-live-admin-secret"
	recorder := httptest.NewRecorder()
	WriteError(recorder, NewError(CodeInternal, "provider authorization Bearer "+secret))

	var envelope struct {
		Error struct {
			Code    ErrorCode `json:"code"`
			Message string    `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("invalid error envelope: %v", err)
	}
	if envelope.Error.Code != CodeInternal || strings.Contains(envelope.Error.Message, secret) {
		t.Fatalf("secret-bearing admin message escaped: %#v", envelope.Error)
	}
}

func TestSecurityVerificationRedactsSensitiveAdminDetails(t *testing.T) {
	const secret = "sk-live-admin-secret"
	recorder := httptest.NewRecorder()
	WriteError(recorder, NewError(CodeInvalidRequest, "invalid request").WithDetails(map[string]any{
		"authorization": secret,
		"field":         "model",
	}))
	if strings.Contains(recorder.Body.String(), secret) {
		t.Fatalf("admin error details leaked secret: %s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "model") {
		t.Fatalf("non-sensitive admin detail was lost: %s", recorder.Body.String())
	}
}
