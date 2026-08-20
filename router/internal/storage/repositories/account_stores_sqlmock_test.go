package repositories

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	accounts "github.com/cartethyia/daemon/internal/accounts/auth"
	"github.com/cartethyia/daemon/internal/storage/models"
)

func testAccountStores(t *testing.T) *BunAccountStores {
	t.Helper()
	db, _ := newFakeBun(t)
	stores, err := NewBunAccountStores(db, []byte("sixteen-byte-key!"))
	if err != nil {
		t.Fatal(err)
	}
	return stores
}

func validAccountConfig(t *testing.T) *accounts.AccountConfig {
	t.Helper()
	ref, err := accounts.NewReference("cred-ref-1")
	if err != nil {
		t.Fatal(err)
	}
	return &accounts.AccountConfig{
		ID: "acc-1", ProviderID: "openai", Kind: accounts.KindOAuth, Enabled: true,
		Labels: map[string]string{"tier": "pro"}, CredentialRef: ref,
		OAuthClientID: "client", RedirectURI: "https://example.com/cb", Scopes: []string{"a"},
	}
}

func TestAccountStoresSQLMockCore(t *testing.T) {
	ctx := context.Background()
	cfg := validAccountConfig(t)

	t.Run("PutConfig", func(t *testing.T) {
		db, mock := newFakeBun(t)
		s, err := NewBunAccountStores(db, []byte("sixteen-byte-key!"))
		if err != nil {
			t.Fatal(err)
		}
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		if err := s.PutConfig(ctx, cfg); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("GetConfig", func(t *testing.T) {
		db, mock := newFakeBun(t)
		s, _ := NewBunAccountStores(db, []byte("sixteen-byte-key!"))
		cols := []string{"id", "provider_id", "kind", "enabled", "labels_json", "credential_ref", "oauth_client_id", "redirect_uri", "scopes_json"}
		expectAnyQueryRows(mock, cols, []any{"acc-1", "openai", "oauth", true, []byte(`{"tier":"pro"}`), []byte("cred-ref-1"), []byte("client"), []byte("https://example.com/cb"), []byte(`["a"]`)})
		got, err := s.GetConfig(ctx, "acc-1")
		if err != nil || got.ID != "acc-1" {
			t.Fatalf("GetConfig = %#v err=%v", got, err)
		}
		db2, mock2 := newFakeBun(t)
		s2, _ := NewBunAccountStores(db2, []byte("sixteen-byte-key!"))
		expectAnyQueryErr(mock2, sql.ErrNoRows)
		_, err = s2.GetConfig(ctx, "missing")
		if !errors.Is(err, accounts.ErrAccountNotFound) {
			t.Fatalf("want ErrAccountNotFound got %v", err)
		}
	})

	t.Run("ListConfigs", func(t *testing.T) {
		db, mock := newFakeBun(t)
		s, _ := NewBunAccountStores(db, []byte("sixteen-byte-key!"))
		cols := []string{"id", "provider_id", "kind", "enabled", "labels_json", "credential_ref", "oauth_client_id", "redirect_uri", "scopes_json"}
		expectAnyQueryRows(mock, cols, []any{"acc-1", "openai", "oauth", true, []byte(`{}`), []byte("cred-ref-1"), []byte(""), []byte(""), []byte(`[]`)})
		got, err := s.ListConfigs(ctx)
		if err != nil || len(got) != 1 {
			t.Fatalf("ListConfigs = %#v err=%v", got, err)
		}
	})

	t.Run("ListAccountDirectory", func(t *testing.T) {
		db, mock := newFakeBun(t)
		s, _ := NewBunAccountStores(db, []byte("sixteen-byte-key!"))
		now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
		cols := []string{
			"config_id", "config_provider_id", "config_kind", "config_enabled", "config_labels_json",
			"config_credential_ref", "config_oauth_client_id", "config_redirect_uri", "config_scopes_json",
			"record_account_id", "record_provider_id", "record_kind", "record_origin",
			"record_access_fingerprint", "record_refresh_fingerprint", "record_expires_at",
			"record_scope", "record_provider_account_id", "record_email", "record_org_id", "record_org_name",
			"record_issued_at", "record_reauthentication_required", "record_version",
		}
		expectAnyQueryRows(mock, cols, []any{
			"acc-1", "openai", "oauth", true, []byte(`{}`), []byte("cred-ref-1"), []byte(""), []byte(""), []byte(`[]`),
			"", "", "", "", "", "", now, "", "", "", "", "", now, false, int64(0),
		})
		got, err := s.ListAccountDirectory(ctx, "openai")
		if err != nil || len(got) != 1 || got[0].Record != nil {
			t.Fatalf("directory without record = %#v err=%v", got, err)
		}

		db2, mock2 := newFakeBun(t)
		s2, _ := NewBunAccountStores(db2, []byte("sixteen-byte-key!"))
		expectAnyQueryRows(mock2, cols, []any{
			"acc-1", "openai", "oauth", true, []byte(`{}`), []byte("cred-ref-1"), []byte(""), []byte(""), []byte(`[]`),
			"acc-1", "openai", "oauth", "oauth", "af", "rf", now, "scope", "pa", "e@x", "org", "Org", now, false, int64(3),
		})
		got, err = s2.ListAccountDirectory(ctx, "openai")
		if err != nil || len(got) != 1 || got[0].Record == nil || got[0].Record.Version != 3 {
			t.Fatalf("directory with record = %#v err=%v", got, err)
		}
	})

	t.Run("healthAndLocks", func(t *testing.T) {
		db, mock := newFakeBun(t)
		s, _ := NewBunAccountStores(db, []byte("sixteen-byte-key!"))
		expectAnyQueryErr(mock, sql.ErrNoRows)
		h, err := s.GetHealth(ctx, "acc-1")
		if err != nil || h.Status != "healthy" {
			t.Fatalf("missing health = %#v err=%v", h, err)
		}
		expectAnyExec(mock, nil)
		if err := s.UpsertHealth(ctx, models.AccountHealth{AccountID: "acc-1", Status: "healthy"}); err != nil {
			t.Fatal(err)
		}
		expectAnyQueryErr(mock, sql.ErrNoRows)
		lock, err := s.GetModelLock(ctx, "acc-1", "gpt")
		if err != nil || lock.AccountID != "acc-1" {
			t.Fatalf("missing lock = %#v err=%v", lock, err)
		}
		expectAnyExec(mock, nil)
		if err := s.UpsertModelLock(ctx, models.AccountModelLock{AccountID: "acc-1", ModelID: "gpt"}); err != nil {
			t.Fatal(err)
		}
		expectAnyExec(mock, nil)
		if err := s.ClearModelLock(ctx, "acc-1", "gpt"); err != nil {
			t.Fatal(err)
		}
		expectAnyExec(mock, nil)
		if err := s.ClearModelLocks(ctx, "acc-1"); err != nil {
			t.Fatal(err)
		}
		expectAnyExec(mock, nil)
		if err := s.DeleteAccount(ctx, "acc-1"); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("secrets", func(t *testing.T) {
		db, mock := newFakeBun(t)
		s, _ := NewBunAccountStores(db, []byte("sixteen-byte-key!"))
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		if err := s.PutAccess(ctx, "acc-1", accounts.NewSecret([]byte("access-token"))); err != nil {
			t.Fatal(err)
		}
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		if err := s.PutRefresh(ctx, "acc-1", accounts.NewSecret([]byte("refresh-token"))); err != nil {
			t.Fatal(err)
		}
		blob, err := s.encrypt([]byte("access-token"))
		if err != nil {
			t.Fatal(err)
		}
		expectAnyQueryRows(mock, []string{"access_blob"}, []any{blob})
		sec, err := s.GetAccess(ctx, "acc-1")
		if err != nil || string(sec.Reveal()) != "access-token" {
			t.Fatalf("GetAccess err=%v", err)
		}
		sec.Close()
		expectAnyQueryErr(mock, sql.ErrNoRows)
		_, err = s.GetRefresh(ctx, "missing")
		if !errors.Is(err, accounts.ErrSecretNotFound) {
			t.Fatalf("want ErrSecretNotFound got %v", err)
		}
		expectAnyExec(mock, nil)
		if err := s.DeleteSecrets(ctx, "acc-1"); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("records", func(t *testing.T) {
		db, mock := newFakeBun(t)
		s, _ := NewBunAccountStores(db, []byte("sixteen-byte-key!"))
		now := time.Now().UTC()
		rec := &accounts.OAuthTokenRecord{
			AccountID: "acc-1", ProviderID: "openai", Kind: accounts.KindOAuth, Origin: accounts.OriginOAuth,
			AccessFingerprint: "af", RefreshFingerprint: "rf", ExpiresAt: now, IssuedAt: now, Version: 1,
		}
		expectAnyExec(mock, nil)
		if err := s.PutRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
		cols := []string{"account_id", "provider_id", "kind", "origin", "access_fingerprint", "refresh_fingerprint", "expires_at", "scope", "provider_account_id", "email", "org_id", "org_name", "issued_at", "reauthentication_required", "version"}
		expectAnyQueryRows(mock, cols, []any{"acc-1", "openai", "oauth", "oauth", "af", "rf", now, "", "", "", "", "", now, false, int64(1)})
		got, err := s.GetRecord(ctx, "acc-1")
		if err != nil || got.AccountID != "acc-1" {
			t.Fatalf("GetRecord = %#v err=%v", got, err)
		}
		expectAnyQueryErr(mock, sql.ErrNoRows)
		_, err = s.GetRecord(ctx, "missing")
		if !errors.Is(err, accounts.ErrRecordNotFound) {
			t.Fatalf("want ErrRecordNotFound got %v", err)
		}
		expectAnyQueryRows(mock, cols, []any{"acc-1", "openai", "oauth", "oauth", "af", "rf", now, "", "", "", "", "", now, false, int64(1)})
		list, err := s.ListRecords(ctx)
		if err != nil || len(list) != 1 {
			t.Fatalf("ListRecords = %#v err=%v", list, err)
		}
		expectAnyExec(mock, nil)
		if err := s.CompareAndSwap(ctx, 1, rec); err != nil {
			t.Fatal(err)
		}
		expectAnyExec(mock, nil)
		if err := s.DeleteRecord(ctx, "acc-1"); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("CommitRefresh", func(t *testing.T) {
		db, mock := newFakeBun(t)
		s, _ := NewBunAccountStores(db, []byte("sixteen-byte-key!"))
		now := time.Now().UTC()
		rec := &accounts.OAuthTokenRecord{
			AccountID: "acc-1", ProviderID: "openai", Kind: accounts.KindOAuth, Origin: accounts.OriginOAuth,
			AccessFingerprint: "af", RefreshFingerprint: "rf", ExpiresAt: now, IssuedAt: now, Version: 2,
		}
		fence := accounts.RefreshFence{OwnerID: "owner-1", Generation: 7}
		mock.ExpectBegin()
		expectAnyQueryRows(mock, []string{"owner_id", "generation", "lease_until_ms"}, []any{"owner-1", int64(7), time.Now().Add(time.Minute).UnixMilli()})
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		mock.ExpectCommit()
		if err := s.CommitRefresh(ctx, 1, fence, rec, accounts.NewSecret([]byte("a")), accounts.NewSecret([]byte("r"))); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("wrappers", func(t *testing.T) {
		db, mock := newFakeBun(t)
		base, _ := NewBunAccountStores(db, []byte("sixteen-byte-key!"))
		cfgStore := &BunAccountConfigStore{BunAccountStores: base}
		secretStore := &BunSecretStore{BunAccountStores: base}
		recordStore := &BunRecordStore{BunAccountStores: base}

		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		if err := cfgStore.Put(ctx, cfg); err != nil {
			t.Fatal(err)
		}
		cols := []string{"id", "provider_id", "kind", "enabled", "labels_json", "credential_ref", "oauth_client_id", "redirect_uri", "scopes_json"}
		expectAnyQueryRows(mock, cols, []any{"acc-1", "openai", "oauth", true, []byte(`{}`), []byte("cred-ref-1"), []byte(""), []byte(""), []byte(`[]`)})
		if _, err := cfgStore.Get(ctx, "acc-1"); err != nil {
			t.Fatal(err)
		}
		expectAnyQueryRows(mock, cols, []any{"acc-1", "openai", "oauth", true, []byte(`{}`), []byte("cred-ref-1"), []byte(""), []byte(""), []byte(`[]`)})
		if _, err := cfgStore.List(ctx); err != nil {
			t.Fatal(err)
		}
		expectAnyExec(mock, nil)
		if err := cfgStore.Delete(ctx, "acc-1"); err != nil {
			t.Fatal(err)
		}
		expectAnyExec(mock, nil)
		if err := secretStore.Delete(ctx, "acc-1"); err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		rec := &accounts.OAuthTokenRecord{AccountID: "acc-1", ProviderID: "openai", Kind: accounts.KindOAuth, Origin: accounts.OriginOAuth, ExpiresAt: now, IssuedAt: now}
		expectAnyExec(mock, nil)
		if err := recordStore.Put(ctx, rec); err != nil {
			t.Fatal(err)
		}
		rcols := []string{"account_id", "provider_id", "kind", "origin", "access_fingerprint", "refresh_fingerprint", "expires_at", "scope", "provider_account_id", "email", "org_id", "org_name", "issued_at", "reauthentication_required", "version"}
		expectAnyQueryRows(mock, rcols, []any{"acc-1", "openai", "oauth", "oauth", "", "", now, "", "", "", "", "", now, false, int64(0)})
		if _, err := recordStore.Get(ctx, "acc-1"); err != nil {
			t.Fatal(err)
		}
		expectAnyQueryRows(mock, rcols, []any{"acc-1", "openai", "oauth", "oauth", "", "", now, "", "", "", "", "", now, false, int64(0)})
		if _, err := recordStore.List(ctx); err != nil {
			t.Fatal(err)
		}
		expectAnyExec(mock, nil)
		if err := recordStore.Delete(ctx, "acc-1"); err != nil {
			t.Fatal(err)
		}
		mock.ExpectBegin()
		expectAnyQueryRows(mock, []string{"owner_id", "generation", "lease_until_ms"}, []any{"owner-1", int64(7), time.Now().Add(time.Minute).UnixMilli()})
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		mock.ExpectCommit()
		if err := recordStore.CommitRefresh(ctx, 0, accounts.RefreshFence{OwnerID: "owner-1", Generation: 7}, rec, nil, nil); err != nil {
			t.Fatal(err)
		}
	})
}
