package auth

import (
	"errors"
	"testing"
	"time"
)

func TestManagerComprehensiveFlows(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	m := NewManager(ManagerOptions{
		TTL: time.Hour,
		Now: func() time.Time { return now },
	})

	// Start validations
	if _, err := m.Start("", FlowBrowser, "", "", "", 0); err == nil {
		t.Fatal("empty provider should fail")
	}
	if _, err := m.Start("p", OAuthFlowKind("invalid"), "", "", "", 0); err == nil {
		t.Fatal("invalid flow should fail")
	}

	// StartFromOAuth
	res := OAuthStartResult{
		AuthorizationURL: "https://auth.example.com",
		State:            "custom-state",
		CodeVerifier:     "custom-verifier",
		UserCode:         "USER1",
		VerificationURI:  "https://verify.example.com",
		IntervalSeconds:  5,
		ExpiresAt:        now.Add(10 * time.Minute),
	}
	sOAuth, err := m.StartFromOAuth("openai", FlowBrowser, res)
	if err != nil {
		t.Fatal(err)
	}
	if sOAuth.AuthorizationURL != "https://auth.example.com" {
		t.Fatalf("auth URL = %q", sOAuth.AuthorizationURL)
	}

	// StartFromOAuth validation errors
	if _, err := m.StartFromOAuth("", FlowBrowser, res); err == nil {
		t.Fatal("empty provider should fail")
	}
	if _, err := m.StartFromOAuth("p", "unsupported", res); err == nil {
		t.Fatal("unsupported flow should fail")
	}

	// StateForDriver
	st, err := m.StateForDriver(sOAuth.ID, "openai")
	if err != nil || st != "custom-state" {
		t.Fatalf("StateForDriver = %q, %v", st, err)
	}
	if _, err := m.StateForDriver(sOAuth.ID, "wrong"); !errors.Is(err, ErrSessionProviderMismatch) {
		t.Fatalf("wrong provider err = %v", err)
	}

	// ConsumeCallbackForExchange - invalid state
	if _, _, err := m.ConsumeCallbackForExchange(sOAuth.ID, "openai", "http://127.0.0.1/cb?code=c&state=bad", "https://redirect"); !errors.Is(err, ErrInvalidCallback) {
		t.Fatalf("bad state err = %v", err)
	}

	// ConsumeCallbackForExchange - provider error (denied)
	deniedS, _ := m.Start("openai", FlowBrowser, "", "", "", 0)
	deniedPriv := m.sessions[deniedS.ID]
	if _, _, err := m.ConsumeCallbackForExchange(deniedS.ID, "openai", "http://127.0.0.1/cb?error=access_denied&state="+deniedPriv.State, "https://redirect"); err == nil {
		t.Fatal("expected access_denied error")
	}
	if m.sessions[deniedS.ID].Status != StatusDenied {
		t.Fatalf("status = %v, want denied", m.sessions[deniedS.ID].Status)
	}

	// ConsumeCallbackForExchange - success
	sEx, _, err := m.ConsumeCallbackForExchange(sOAuth.ID, "openai", "http://127.0.0.1/cb?code=c123&state=custom-state", "https://redirect")
	if err != nil {
		t.Fatal(err)
	}
	if sEx.Status != StatusCompleted || !sEx.Consumed {
		t.Fatalf("sEx = %+v", sEx)
	}

	// ConsumeCodeForExchange
	sCode, err := m.Start("claude", FlowBrowser, "", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	codePriv := m.sessions[sCode.ID]
	if _, _, err := m.ConsumeCodeForExchange(sCode.ID, "claude", "c99", "wrong", "https://redir"); !errors.Is(err, ErrInvalidCallback) {
		t.Fatalf("bad state err = %v", err)
	}
	sCompletedCode, exInput, err := m.ConsumeCodeForExchange(sCode.ID, "claude", "c99", codePriv.State, "https://redir")
	if err != nil || sCompletedCode.Status != StatusCompleted || exInput.Code != "c99" {
		t.Fatalf("ConsumeCodeForExchange: %+v, %+v, %v", sCompletedCode, exInput, err)
	}

	// CompleteDevice
	sDev, err := m.Start("dev-provider", FlowDevice, "", "CODE", "https://verify", 5)
	if err != nil {
		t.Fatal(err)
	}
	sDevCompleted, err := m.CompleteDevice(sDev.ID, "dev-provider")
	if err != nil || sDevCompleted.Status != StatusCompleted {
		t.Fatalf("CompleteDevice: %+v, %v", sDevCompleted, err)
	}
	if _, err := m.CompleteDevice(sDev.ID, "dev-provider"); !errors.Is(err, ErrSessionConsumed) {
		t.Fatalf("re-complete device err = %v", err)
	}

	// Fail
	sFail, _ := m.Start("fail-provider", FlowBrowser, "", "", "", 0)
	if _, err := m.Fail(sFail.ID, "fail-provider", StatusCompleted); err == nil {
		t.Fatal("invalid terminal status should fail")
	}
	sFailed, err := m.Fail(sFail.ID, "fail-provider", StatusDenied)
	if err != nil || sFailed.Status != StatusDenied {
		t.Fatalf("Fail: %+v, %v", sFailed, err)
	}

	// Cancel
	sCancel, _ := m.Start("cancel-provider", FlowBrowser, "", "", "", 0)
	if err := m.Cancel(sCancel.ID, "cancel-provider"); err != nil {
		t.Fatal(err)
	}
	if m.sessions[sCancel.ID].Status != StatusCancelled {
		t.Fatalf("cancel status = %v", m.sessions[sCancel.ID].Status)
	}

	// Remove
	m.Remove(sCancel.ID)
	if _, err := m.Get(sCancel.ID, "cancel-provider"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("after remove err = %v", err)
	}

	// IDs
	ids := m.IDs()
	_ = ids
}

func TestParseLoopbackCallbackErrors(t *testing.T) {
	if _, _, _, err := ParseLoopbackCallback(""); err == nil {
		t.Fatal("empty url should error")
	}
	if _, _, _, err := ParseLoopbackCallback("http://example.com/not-cb?code=1"); err == nil {
		t.Fatal("bad path should error")
	}
	code, state, provErr, err := ParseLoopbackCallback("http://127.0.0.1/callback?code=abc&state=xyz")
	if err != nil || code != "abc" || state != "xyz" || provErr != "" {
		t.Fatalf("parse callback: code=%q state=%q provErr=%q err=%v", code, state, provErr, err)
	}
	_, _, provErr, err = ParseLoopbackCallback("http://127.0.0.1/callback?error=invalid_grant&state=xyz")
	if err != nil || provErr != "invalid_grant" {
		t.Fatalf("parse callback with error: provErr=%q err=%v", provErr, err)
	}
}
