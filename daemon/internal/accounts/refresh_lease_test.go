package accounts

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
	refresher, err := NewInMemoryRefresher(RefresherOptions{
		Driver: driver, Secrets: secrets, Records: NewMemoryRecordStore(), Accounts: accounts,
		Lease: NewMemoryRefreshLeaseStore(), LeaseTTL: 20 * time.Millisecond, RefreshTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		time.Sleep(70 * time.Millisecond)
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
