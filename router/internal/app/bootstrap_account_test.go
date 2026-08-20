package app

import (
	"context"
	"errors"
	"testing"

	accounts "github.com/cartethyia/daemon/internal/accounts/auth"
	proxy "github.com/cartethyia/daemon/internal/router"
)

type joinedDirectoryStore struct {
	entries []accounts.AccountDirectoryEntry
	joined  int
}

func (s *joinedDirectoryStore) Put(context.Context, *accounts.AccountConfig) error { return nil }
func (s *joinedDirectoryStore) Get(context.Context, string) (*accounts.AccountConfig, error) {
	return nil, errors.New("unexpected config Get")
}
func (s *joinedDirectoryStore) List(context.Context) ([]*accounts.AccountConfig, error) {
	return nil, errors.New("unexpected config List")
}
func (s *joinedDirectoryStore) Delete(context.Context, string) error { return nil }
func (s *joinedDirectoryStore) ListAccountDirectory(_ context.Context, providerID string) ([]accounts.AccountDirectoryEntry, error) {
	s.joined++
	if providerID != "provider" {
		return nil, errors.New("wrong provider filter")
	}
	return append([]accounts.AccountDirectoryEntry(nil), s.entries...), nil
}

func TestDurableAccountStoreUsesJoinedDirectoryProjection(t *testing.T) {
	ref, err := accounts.NewReference("account-1")
	if err != nil {
		t.Fatal(err)
	}
	store := &joinedDirectoryStore{entries: []accounts.AccountDirectoryEntry{
		{Config: &accounts.AccountConfig{ID: "account-1", ProviderID: "provider", Enabled: true, Kind: accounts.KindAPIKey, CredentialRef: ref}, Record: &accounts.OAuthTokenRecord{AccountID: "account-1", Email: "user@example.test", ReauthenticationRequired: true}},
		{Config: &accounts.AccountConfig{ID: "disabled", ProviderID: "provider", Enabled: false, Kind: accounts.KindAPIKey}},
		{Config: &accounts.AccountConfig{ID: "other-provider", ProviderID: "other", Enabled: true, Kind: accounts.KindAPIKey}},
	}}
	out, err := (durableAccountStore{store: store}).ListAccounts(context.Background(), "provider")
	if err != nil {
		t.Fatal(err)
	}
	if store.joined != 1 {
		t.Fatalf("joined directory calls = %d, want 1", store.joined)
	}
	if len(out) != 1 {
		t.Fatalf("accounts = %d, want 1", len(out))
	}
	if out[0].Email != "user@example.test" || !out[0].ReauthRequired {
		t.Fatalf("joined metadata not projected: %#v", out[0])
	}
	if out[0].CredentialRef.String() != "account-1" {
		t.Fatalf("credential reference = %q", out[0].CredentialRef.String())
	}
}

var _ proxy.AccountStore = durableAccountStore{}
