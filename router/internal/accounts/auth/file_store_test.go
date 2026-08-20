package auth

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileStorePersistsEncryptedSecretsAndCAS(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounts.json")
	store, err := OpenFileStore(path, []byte("test-encryption-key"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	cfg := &AccountConfig{ID: "acct", ProviderID: "claude", Kind: KindOAuth, Enabled: true}
	if err := store.Accounts().Put(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	if err := store.Secrets().PutAccess(ctx, "acct", NewSecretFromString("access-secret")); err != nil {
		t.Fatal(err)
	}
	if err := store.Secrets().PutRefresh(ctx, "acct", NewSecretFromString("refresh-secret")); err != nil {
		t.Fatal(err)
	}
	record := &OAuthTokenRecord{AccountID: "acct", ProviderID: "claude", Kind: KindOAuth}
	if err := store.Records().CompareAndSwap(ctx, -1, record); err != nil {
		t.Fatal(err)
	}
	if err := store.Records().CompareAndSwap(ctx, -1, record); err == nil {
		t.Fatal("CAS accepted duplicate create")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "access-secret") || strings.Contains(string(raw), "refresh-secret") {
		t.Fatal("plaintext secret persisted")
	}
	loaded, err := OpenFileStore(path, []byte("test-encryption-key"))
	if err != nil {
		t.Fatal(err)
	}
	access, err := loaded.Secrets().GetAccess(ctx, "acct")
	if err != nil {
		t.Fatal(err)
	}
	if access.RevealString() != "access-secret" {
		t.Fatal("access secret mismatch")
	}
	access.Close()
	refresh, err := loaded.Secrets().GetRefresh(ctx, "acct")
	if err != nil {
		t.Fatal(err)
	}
	refresh.Close()
	if err := loaded.Secrets().Delete(ctx, "acct"); err != nil {
		t.Fatal(err)
	}
	if _, err := loaded.Secrets().GetAccess(ctx, "acct"); err == nil {
		t.Fatal("delete left access secret")
	}
}
