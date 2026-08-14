package capture

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCaptureDisabledAndRedactsSecrets(t *testing.T) {
	now := time.Now()
	s := New(Config{Enabled: true, MaxBytes: 128, MaxRecords: 2, Retention: time.Hour})
	if err := s.Capture("1", "req-1", "openai", []byte(`{"authorization":"Bearer secret-value","model":"x"}`), now); err != nil {
		t.Fatal(err)
	}
	items := s.List(now)
	if len(items) != 1 {
		t.Fatalf("records=%d", len(items))
	}
	if strings.Contains(string(items[0].Body), "secret-value") || !items[0].Metadata.Sensitive || !items[0].Metadata.Redacted {
		t.Fatalf("sensitive payload or metadata leaked: %+v", items[0])
	}
	if err := New(Config{}).Capture("1", "r", "p", []byte(`{"secret":"not-stored"}`), now); err != nil {
		t.Fatalf("disabled capture is optional absence: %v", err)
	}
}

func TestCaptureProviderOptOutAndScope(t *testing.T) {
	now := time.Now()
	s := New(Config{Enabled: true, Scope: Scope{Providers: map[string]struct{}{"openai": {}}}, ProviderOptOut: map[string]bool{"openai": true}})
	if err := s.Capture("1", "r", "openai", []byte(`{"model":"x"}`), now); err != nil {
		t.Fatal(err)
	}
	if got := s.List(now); len(got) != 0 {
		t.Fatalf("opted out provider stored %d records", len(got))
	}
	if err := s.Capture("1", "r", "anthropic", []byte(`{"model":"x"}`), now); err != nil {
		t.Fatal(err)
	}
	if got := s.List(now); len(got) != 0 {
		t.Fatalf("out-of-scope provider stored %d records", len(got))
	}
}
func TestCaptureRedactionFailureFailClosed(t *testing.T) {
	now := time.Now()
	s := New(Config{Enabled: true})
	err := s.Capture("1", "r", "p", []byte{0xff, 0xfe}, now)
	if !errors.Is(err, ErrRedaction) || !errors.Is(err, ErrSensitive) || CodeOf(err) != CodeRedaction {
		t.Fatalf("redaction error=%v code=%s", err, CodeOf(err))
	}
	if got := s.List(now); len(got) != 0 {
		t.Fatalf("redaction failure stored %d records", len(got))
	}
}

func TestCaptureBoundsAndExpiry(t *testing.T) {
	now := time.Now()
	s := New(Config{Enabled: true, MaxBytes: 3, MaxRecords: 1, MaxTotalBytes: 3, Retention: time.Second})
	if err := s.Capture("1", "r", "p", []byte("long"), now); !errors.Is(err, ErrLimit) || CodeOf(err) != CodeLimit {
		t.Fatalf("limit=%v", err)
	}
	if err := s.Capture("1", "r", "p", []byte("ok"), now); err != nil {
		t.Fatal(err)
	}
	if got := s.DeleteExpired(now.Add(2 * time.Second)); got != 1 {
		t.Fatalf("deleted=%d", got)
	}
	if got := s.AuditEvents(); len(got) < 2 || got[len(got)-1].Action != AuditDeleted {
		t.Fatalf("missing deletion audit: %+v", got)
	}
}

func TestCaptureContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := New(Config{Enabled: true}).CaptureContext(ctx, "1", "r", "p", []byte("ok"), time.Now()); !errors.Is(err, ErrCancelled) {
		t.Fatalf("cancel=%v", err)
	}
}

func TestRetentionWorkerStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := New(Config{Enabled: true}).RunRetention(ctx, time.Millisecond); err != nil {
		t.Fatalf("worker=%v", err)
	}
}
