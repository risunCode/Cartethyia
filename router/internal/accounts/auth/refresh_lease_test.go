package auth

import (
	"context"
	"testing"
	"time"
)

func TestMemoryRefreshLeaseRenewalExtendsExpiry(t *testing.T) {
	store := NewMemoryRefreshLeaseStore()
	lease, acquired, err := store.Acquire(context.Background(), "acct", "owner-a", 40*time.Millisecond)
	if err != nil || !acquired {
		t.Fatalf("Acquire = (%v, %v), want acquired", err, acquired)
	}
	defer lease.Release(context.Background())
	if ok, err := store.Renew(context.Background(), "acct", lease.Fence(), 120*time.Millisecond); err != nil || !ok {
		t.Fatalf("Renew = (%v, %v), want true", err, ok)
	}
	time.Sleep(55 * time.Millisecond)
	if _, acquired, err := store.Acquire(context.Background(), "acct", "owner-b", 40*time.Millisecond); err != nil || acquired {
		t.Fatalf("renewed lease was not held: acquired=%v err=%v", acquired, err)
	}
}

func TestMemoryRefreshLeaseRejectsStaleGenerationAndExpiry(t *testing.T) {
	store := NewMemoryRefreshLeaseStore()
	first, acquired, err := store.Acquire(context.Background(), "acct", "owner-a", 10*time.Millisecond)
	if err != nil || !acquired {
		t.Fatalf("first Acquire = (%v, %v)", err, acquired)
	}
	time.Sleep(25 * time.Millisecond)
	second, acquired, err := store.Acquire(context.Background(), "acct", "owner-b", time.Second)
	if err != nil || !acquired {
		t.Fatalf("second Acquire = (%v, %v)", err, acquired)
	}
	defer second.Release(context.Background())
	if ok, err := store.Renew(context.Background(), "acct", first.Fence(), time.Second); err != nil || ok {
		t.Fatalf("stale Renew = (%v, %v), want false", err, ok)
	}
	if err := first.Renew(context.Background(), time.Second); err == nil {
		t.Fatal("stale handle renewal unexpectedly succeeded")
	}
}

func TestRefresherRenewsLeaseDuringLongRefresh(t *testing.T) {
	ctx := context.Background()
	accounts := NewMemoryAccountConfigStore()
	if err := accounts.Put(ctx, &AccountConfig{ID: "acct", ProviderID: "provider", Kind: KindOAuth}); err != nil {
		t.Fatal(err)
	}
	secrets := NewMemorySecretStore()
	if err := secrets.PutRefresh(ctx, "acct", NewSecretFromString("refresh")); err != nil {
		t.Fatal(err)
	}
	driver := &testAuthDriver{release: make(chan struct{}), result: &TokenSet{Access: NewSecretFromString("access"), ExpiresAt: time.Now().Add(time.Hour)}}
	// LeaseTTL/renewal-wait margins are wide (not the original 20ms/70ms) on
	// purpose: the refresher renews every leaseTTL/3, and a tight margin
	// makes this test flaky under any scheduler jitter or GC pause (missing
	// two renewal ticks at 20ms/3\u22486.7ms apart is easy on a loaded machine).
	// 150ms/350ms preserves the same behavior under test (several renewals
	// complete during a refresh that outlives one lease TTL) with slack an
	// order of magnitude larger than realistic jitter.
	refresher, err := NewInMemoryRefresher(RefresherOptions{
		Driver: driver, Secrets: secrets, Records: NewMemoryRecordStore(), Accounts: accounts,
		Lease: NewMemoryRefreshLeaseStore(), LeaseTTL: 150 * time.Millisecond, RefreshTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		time.Sleep(350 * time.Millisecond)
		close(driver.release)
		close(done)
	}()
	token, err := refresher.ForceRefresh(ctx, "acct")
	<-done
	if err != nil {
		t.Fatalf("ForceRefresh = %v", err)
	}
	if token == nil || token.Access.RevealString() != "access" {
		t.Fatalf("token = %#v", token)
	}
	token.Close()
}
