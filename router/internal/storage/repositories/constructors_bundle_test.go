package repositories

import (
	"testing"
	"time"

	router "github.com/cartethyia/daemon/internal/router"
)

func TestConstructorsAndBundle(t *testing.T) {
	db, _ := newFakeBun(t)

	if NewBunBanRepository(db) == nil {
		t.Fatal("ban constructor returned nil")
	}
	proxy := NewBunProxyRepository(db)
	if proxy == nil || proxy.custom == nil {
		t.Fatal("proxy constructor missing custom repo")
	}
	if NewBunProxyRepository(nil).db != nil {
		t.Fatal("nil db proxy should be empty handle")
	}
	if NewBunSettingsRepository(db) == nil || NewBunCatalogRepository(db) == nil {
		t.Fatal("settings/catalog constructors returned nil")
	}
	if NewBunAPIKeyRepository(db) == nil || NewBunPublicAPIKeyResolver(db) == nil {
		t.Fatal("apikey constructors returned nil")
	}
	if NewBunCustomProviderRepository(db) == nil || NewBunTelemetryRepository(db) == nil {
		t.Fatal("custom/telemetry constructors returned nil")
	}
	if NewBunMetadataSink(NewBunTelemetryRepository(db)) == nil {
		t.Fatal("metadata sink constructor returned nil")
	}
	if NewBunRefreshLeaseStore(db) == nil {
		t.Fatal("refresh lease constructor returned nil")
	}

	tb := NewBunTokenBudgetRepository(db)
	if tb == nil || tb.reservationTTL != defaultTokenReservationTTL || tb.maxRecoveryBatch != defaultTokenRecoveryBatch {
		t.Fatalf("token budget defaults = %#v", tb)
	}
	tb2 := NewBunTokenBudgetRepositoryWithOptions(db, TokenBudgetOptions{ReservationTTL: -1, MaxRecoveryBatch: maxTokenRecoveryBatch + 5})
	if tb2.reservationTTL != defaultTokenReservationTTL || tb2.maxRecoveryBatch != defaultTokenRecoveryBatch {
		t.Fatalf("token budget option clamping = %#v", tb2)
	}
	tb3 := NewBunTokenBudgetRepositoryWithOptions(db, TokenBudgetOptions{ReservationTTL: time.Minute, MaxRecoveryBatch: 10})
	if tb3.reservationTTL != time.Minute || tb3.maxRecoveryBatch != 10 {
		t.Fatalf("token budget custom options = %#v", tb3)
	}

	if _, err := NewBunAccountStores(nil, []byte("sixteen-byte-key!")); err == nil {
		t.Fatal("expected nil db error")
	}
	if _, err := NewBunAccountStores(db, []byte("short")); err == nil {
		t.Fatal("expected short key error")
	}
	if _, err := NewBunAccountStores(db, []byte("sixteen-byte-key!")); err != nil {
		t.Fatal(err)
	}

	var b Bundle
	b = b.WithAccounts(nil).WithAPIKeys(nil).WithProxies(nil).WithSettings(nil).
		WithBans(nil).WithTelemetry(nil).WithMigrator(nil).
		WithTokenBudget(router.TokenBudgetAuthority(nil))
	_ = b
}
