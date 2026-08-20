package auth

import (
	"context"
	"errors"
	"testing"
)

func TestMemoryStoresReturnTypedMissingErrors(t *testing.T) {
	ctx := context.Background()
	secrets := NewMemorySecretStore()
	if _, err := secrets.GetAccess(ctx, "missing"); !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("access error = %v", err)
	}
	if _, err := secrets.GetRefresh(ctx, "missing"); !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("refresh error = %v", err)
	}
	records := NewMemoryRecordStore()
	if _, err := records.Get(ctx, "missing"); !errors.Is(err, ErrRecordNotFound) {
		t.Fatalf("record error = %v", err)
	}
	accounts := NewMemoryAccountConfigStore()
	if _, err := accounts.Get(ctx, "missing"); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("account error = %v", err)
	}
}
