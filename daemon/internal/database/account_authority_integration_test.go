package db

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
)

// TestPostgreSQLAccountAuthorityIntegration exercises the real migration,
// joined directory, encrypted secret, lease fence, and atomic refresh commit.
// It is opt-in because the repository does not provision PostgreSQL itself.
func TestPostgreSQLAccountAuthorityIntegration(t *testing.T) {
	rawURL := os.Getenv("CARTETHYIA_POSTGRES_URL")
	if rawURL == "" {
		t.Skip("set CARTETHYIA_POSTGRES_URL to run PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store, err := OpenRuntime(ctx, rawURL, []byte("integration-key-material-32-bytes-long"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close(context.Background())

	const accountID = "integration-account-authority"
	cfg := &accounts.AccountConfig{ID: accountID, ProviderID: "openai", Kind: accounts.KindOAuth, Enabled: true}
	ref, err := accounts.NewReference(accountID)
	if err != nil {
		t.Fatal(err)
	}
	cfg.CredentialRef = ref
	if err := store.Accounts.Put(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	defer store.Accounts.Delete(context.Background(), accountID)
	if err := store.Secrets.PutAccess(ctx, accountID, accounts.NewSecret([]byte("access-before"))); err != nil {
		t.Fatal(err)
	}
	if err := store.Secrets.PutRefresh(ctx, accountID, accounts.NewSecret([]byte("refresh-before"))); err != nil {
		t.Fatal(err)
	}
	record := &accounts.OAuthTokenRecord{AccountID: accountID, ProviderID: "openai", Kind: accounts.KindOAuth, Version: 0, AccessFingerprint: "access-before", RefreshFingerprint: "refresh-before"}
	if err := store.Records.Put(ctx, record); err != nil {
		t.Fatal(err)
	}
	entries, err := store.AccountCore.ListAccountDirectory(ctx, "openai")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 || entries[0].Config == nil || entries[0].Record == nil {
		t.Fatalf("joined directory = %#v", entries)
	}

	lease, acquired, err := store.RefreshLeases.Acquire(ctx, accountID, "integration-owner", time.Minute)
	if err != nil || !acquired {
		t.Fatalf("acquire lease: acquired=%v err=%v", acquired, err)
	}
	defer lease.Release(context.Background())
	fresh := &accounts.OAuthTokenRecord{AccountID: accountID, ProviderID: "openai", Kind: accounts.KindOAuth, Version: 1, AccessFingerprint: "access-after", RefreshFingerprint: "refresh-after"}
	if err := store.AccountCore.CommitRefresh(ctx, 0, lease.Fence(), fresh, accounts.NewSecret([]byte("access-after")), accounts.NewSecret([]byte("refresh-after"))); err != nil {
		t.Fatal(err)
	}
	access, err := store.Secrets.GetAccess(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	defer access.Close()
	if access.RevealString() != "access-after" {
		t.Fatalf("access after commit = %q", access.RevealString())
	}
}
