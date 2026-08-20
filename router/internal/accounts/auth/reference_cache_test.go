package auth

import (
	"context"
	"testing"
	"time"
)

type countingSecretStore struct {
	*MemorySecretStore
	accessGets int
}

func (s *countingSecretStore) GetAccess(ctx context.Context, accountID string) (*Secret, error) {
	s.accessGets++
	return s.MemorySecretStore.GetAccess(ctx, accountID)
}

func newCachedResolver(t *testing.T, ttl time.Duration, max int) (*StoreCredentialResolver, *countingSecretStore, Reference) {
	t.Helper()
	ctx := context.Background()
	accountStore := NewMemoryAccountConfigStore()
	if err := accountStore.Put(ctx, &AccountConfig{ID: "account-1", ProviderID: "provider", Kind: KindAPIKey, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	secrets := &countingSecretStore{MemorySecretStore: NewMemorySecretStore()}
	if err := secrets.PutAccess(ctx, "account-1", NewSecretFromString("access-one")); err != nil {
		t.Fatal(err)
	}
	cfg, err := accountStore.Get(ctx, "account-1")
	if err != nil {
		t.Fatal(err)
	}
	resolver, err := NewStoreCredentialResolver(StoreResolverOptions{
		Accounts: accountStore,
		Secrets:  secrets,
		AccessCache: CredentialCacheOptions{
			TTL: ttl, MaxEntries: max,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return resolver, secrets, cfg.CredentialRef
}

func TestStoreCredentialResolverCacheHitAndDefensiveCopy(t *testing.T) {
	resolver, secrets, ref := newCachedResolver(t, time.Minute, 2)
	first, err := resolver.Resolve(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	first.Close()
	second, err := resolver.Resolve(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	if secrets.accessGets != 1 {
		t.Fatalf("access store gets = %d, want 1", secrets.accessGets)
	}
	if got := second.Access.RevealString(); got != "access-one" {
		t.Fatalf("cached access = %q", got)
	}
	second.Close()
	resolver.Close()
}

func TestStoreCredentialResolverCacheExpiryReloads(t *testing.T) {
	resolver, secrets, ref := newCachedResolver(t, 10*time.Millisecond, 2)
	resolved, err := resolver.Resolve(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	resolved.Close()
	time.Sleep(25 * time.Millisecond)
	resolved, err = resolver.Resolve(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	resolved.Close()
	if secrets.accessGets != 2 {
		t.Fatalf("access store gets after expiry = %d, want 2", secrets.accessGets)
	}
	resolver.Close()
}

func TestStoreCredentialResolverCacheEvictionReplacementDeleteAndCloseZeroSecrets(t *testing.T) {
	resolver, _, ref := newCachedResolver(t, time.Minute, 1)
	resolved, err := resolver.Resolve(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	resolved.Close()
	old := resolver.cache[ref.String()].access
	if old.IsZero() {
		t.Fatal("cache did not retain access material")
	}
	otherRef, err := NewReference("account-2")
	if err != nil {
		t.Fatal(err)
	}
	input := NewSecretFromString("other")
	resolver.cacheCredential(otherRef.String(), CredentialMetadata{Reference: otherRef, AccountID: "account-2", ProviderID: "provider", Kind: KindAPIKey, Origin: OriginAPIKey, HasAccess: true}, input)
	input.Close()
	if !old.IsZero() {
		t.Fatal("evicted cache secret was not closed")
	}
	replacement := resolver.cache[otherRef.String()].access
	input = NewSecretFromString("replacement")
	resolver.cacheCredential(otherRef.String(), CredentialMetadata{Reference: otherRef, AccountID: "account-2", ProviderID: "provider", Kind: KindAPIKey, Origin: OriginAPIKey, HasAccess: true}, input)
	input.Close()
	if !replacement.IsZero() {
		t.Fatal("replaced cache secret was not closed")
	}
	current := resolver.cache[otherRef.String()].access
	resolver.Invalidate(otherRef)
	if !current.IsZero() {
		t.Fatal("invalidated cache secret was not closed")
	}
	resolver.Close()
}
