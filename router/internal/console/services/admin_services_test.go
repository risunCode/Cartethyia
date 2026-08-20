package services

import (
	"testing"
	"time"
)

func TestFormatAdminTime(t *testing.T) {
	if formatAdminTime(nil) != "" {
		t.Fatal("nil time should format empty")
	}
	if formatAdminTime(&time.Time{}) != "" {
		t.Fatal("zero time should format empty")
	}
	now := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	got := formatAdminTime(&now)
	if got != "2025-01-01T00:00:00Z" {
		t.Fatalf("formatted = %q", got)
	}
}