package flow

import (
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
)

func TestManagerBrowserCallbackIsProviderBoundAndOneShot(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	m := NewManager(ManagerOptions{Now: func() time.Time { return now }})
	s, err := m.Start("claude", accounts.FlowBrowser, "https://example.test/authorize", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if s.State != "" || s.CodeVerifier != "" {
		t.Fatal("private state leaked in public session")
	}
	private, ok := m.sessions[s.ID]
	if !ok {
		t.Fatal("session missing")
	}
	if _, err := m.ConsumeCallback(s.ID, "other", "http://127.0.0.1/callback?code=c&state="+private.State); !errors.Is(err, ErrSessionProviderMismatch) {
		t.Fatalf("provider mismatch = %v", err)
	}
	completed, err := m.ConsumeCallback(s.ID, "claude", "http://127.0.0.1/callback?code=code-1&state="+private.State)
	if err != nil || completed.Status != StatusCompleted {
		t.Fatalf("complete = %#v %v", completed, err)
	}
	if _, err := m.ConsumeCallback(s.ID, "claude", "http://127.0.0.1/callback?code=code-2&state="+private.State); !errors.Is(err, ErrSessionConsumed) {
		t.Fatalf("reuse = %v", err)
	}
}

func TestManagerExpiresBoundedDeviceSession(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	m := NewManager(ManagerOptions{Now: func() time.Time { return now }, TTL: time.Minute, MaxSessions: 1})
	s, err := m.Start("codex", accounts.FlowDevice, "", "ABCD", "https://example.test/device", 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start("codex", accounts.FlowDevice, "", "EFGH", "https://example.test/device", 2); err == nil {
		t.Fatal("capacity was not enforced")
	}
	now = now.Add(2 * time.Minute)
	if _, err := m.Get(s.ID, "codex"); !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("expiry = %v", err)
	}
}
