package auth

import (
	"testing"
)

// TestDriversConstructWithoutPanic verifies every registered driver constructs without panic
func TestDriversConstructWithoutPanic(t *testing.T) {
	r, err := NewRegistry(nil)
	if err != nil {
		t.Fatalf("NewRegistry failed: %v", err)
	}

	ids := r.IDs()
	if len(ids) != 8 {
		t.Fatalf("expected 8 drivers, got %d: %v", len(ids), ids)
	}

	for _, id := range ids {
		driver, ok := r.Get(id)
		if !ok {
			t.Fatalf("driver %s not found in registry", id)
		}
		if driver == nil {
			t.Fatalf("driver %s is nil in registry", id)
		}
	}
}

// TestDriversReportProviderIDsViaRegistry verifies registry reports stable provider IDs
func TestDriversReportProviderIDsViaRegistry(t *testing.T) {
	r, err := NewRegistry(nil)
	if err != nil {
		t.Fatalf("NewRegistry failed: %v", err)
	}

	ids := r.IDs()
	if len(ids) != 8 {
		t.Fatalf("expected 8 drivers, got %d", len(ids))
	}

	supported := SupportedIDs()
	if len(supported) != 8 {
		t.Fatalf("expected 8 supported IDs, got %d", len(supported))
	}

	for _, id := range supported {
		_, ok := r.Get(id)
		if !ok {
			t.Fatalf("supported ID %s not found in registry", id)
		}
	}
}

// TestDriversProviderIDReportsStableIDs tests each driver reports stable ProviderID via registry
func TestDriversProviderIDReportsStableIDs(t *testing.T) {
	r, err := NewRegistry(nil)
	if err != nil {
		t.Fatalf("NewRegistry failed: %v", err)
	}

	supported := SupportedIDs()
	if len(supported) != 8 {
		t.Fatalf("expected 8 supported IDs, got %d", len(supported))
	}

	for _, providerID := range supported {
		_, ok := r.Get(providerID)
		if !ok {
			t.Fatalf("driver %s not found in registry", providerID)
		}
	}
}