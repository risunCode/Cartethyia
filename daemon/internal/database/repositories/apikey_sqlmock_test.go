package repositories

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
)

func apiKeyCols() []string {
	return []string{
		"id", "name", "key_prefix", "active", "rate_limit_rpm", "daily_token_limit", "monthly_token_limit",
		"one_time_token_limit", "one_time_tokens_used", "quote_big_text", "quote_sub_text", "quote_body",
		"max_concurrent_requests", "provider_allowlist", "model_allowlist", "model_denylist",
		"disable_remote_mapping", "last_used_at", "created_at", "revoked_at",
	}
}

func apiKeyRowValues(now time.Time) []any {
	return []any{"key-1", "name", "sk-prefix", true, nil, nil, nil, nil, 0, nil, nil, nil, nil, nil, nil, nil, false, nil, now, nil}
}

func shareCols() []string {
	return []string{"id", "api_key_id", "token_hash", "kind", "active", "created_at", "expires_at", "used_at", "last_viewed_at"}
}

func shareRow(now time.Time) []any {
	return []any{"share-1", "key-1", "hash", "monitor", true, now, nil, nil, nil}
}

func TestAPIKeySQLMockCRUD(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

	t.Run("list", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, apiKeyCols(), apiKeyRowValues(now))
		got, err := NewBunAPIKeyRepository(db).List(ctx)
		if err != nil || len(got) != 1 || got[0].ID != "key-1" {
			t.Fatalf("List = %#v err=%v", got, err)
		}
	})

	t.Run("getByID", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, apiKeyCols(), apiKeyRowValues(now))
		got, err := NewBunAPIKeyRepository(db).GetByID(ctx, "key-1")
		if err != nil || got.ID != "key-1" {
			t.Fatalf("GetByID = %#v err=%v", got, err)
		}
	})

	t.Run("getBySecret", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, apiKeyCols(), apiKeyRowValues(now))
		got, err := NewBunAPIKeyRepository(db).GetBySecret(ctx, "sk-live")
		if err != nil || got.ID != "key-1" {
			t.Fatalf("GetBySecret = %#v err=%v", got, err)
		}
	})

	t.Run("credential", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, []string{"key"}, []any{"sk-live"})
		got, err := NewBunAPIKeyRepository(db).Credential(ctx, "key-1")
		if err != nil || got != "sk-live" {
			t.Fatalf("Credential = %q err=%v", got, err)
		}
	})

	t.Run("create", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, apiKeyCols(), apiKeyRowValues(now))
		got, err := NewBunAPIKeyRepository(db).Create(ctx, models.ApiKeyCreateInput{ID: "key-1", Name: "name", Key: "sk-live-secret"})
		if err != nil || got.ID != "key-1" {
			t.Fatalf("Create = %#v err=%v", got, err)
		}
	})

	t.Run("patch", func(t *testing.T) {
		db, mock := newFakeBun(t)
		name := "renamed"
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, apiKeyCols(), apiKeyRowValues(now))
		got, err := NewBunAPIKeyRepository(db).Patch(ctx, "key-1", models.ApiKeyPatchInput{Name: &name})
		if err != nil || got.Name != "name" {
			t.Fatalf("Patch = %#v err=%v", got, err)
		}
	})

	t.Run("revoke", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		ok, err := NewBunAPIKeyRepository(db).Revoke(ctx, "key-1")
		if err != nil || !ok {
			t.Fatalf("Revoke = (%v, %v)", ok, err)
		}
	})

	t.Run("delete", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		ok, err := NewBunAPIKeyRepository(db).Delete(ctx, "key-1")
		if err != nil || !ok {
			t.Fatalf("Delete = (%v, %v)", ok, err)
		}
	})

	t.Run("touch", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		if err := NewBunAPIKeyRepository(db).Touch(ctx, "key-1"); err != nil {
			t.Fatalf("Touch: %v", err)
		}
	})

	t.Run("flushTouches", func(t *testing.T) {
		db, mock := newFakeBun(t)
		repo := NewBunAPIKeyRepository(db)
		repo.pending["key-1"] = struct{}{}
		expectAnyExec(mock, nil)
		if err := repo.FlushTouches(ctx); err != nil {
			t.Fatalf("FlushTouches: %v", err)
		}
	})
}

func TestPublicAPIKeyResolverSQLMock(t *testing.T) {
	ctx := context.Background()
	t.Run("resolve", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, []string{
			"id", "active", "revoked_at", "rate_limit_rpm", "daily_token_limit", "monthly_token_limit",
			"one_time_token_limit", "one_time_tokens_used", "max_concurrent_requests", "provider_allowlist", "model_allowlist", "model_denylist",
		}, []any{"key-1", true, nil, nil, nil, nil, nil, 0, nil, nil, nil, nil})
		got, err := NewBunPublicAPIKeyResolver(db).ResolveAPIKey(ctx, "sk-test")
		if err != nil || got.ID != "key-1" {
			t.Fatalf("ResolveAPIKey = %#v err=%v", got, err)
		}
	})
	t.Run("not found", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryErr(mock, sql.ErrNoRows)
		if _, err := NewBunPublicAPIKeyResolver(db).ResolveAPIKey(ctx, "missing"); err == nil {
			t.Fatal("expected error")
		}
	})
	t.Run("touch", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		if err := NewBunPublicAPIKeyResolver(db).TouchAPIKey(ctx, "key-1"); err != nil {
			t.Fatalf("TouchAPIKey: %v", err)
		}
	})
}

func TestAPIKeyShareLinkSQLMock(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	link := models.ShareLink{ID: "share-1", APIKeyID: "key-1", TokenHash: "hash", Kind: "monitor", Active: true, CreatedAt: now}

	t.Run("create", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, shareCols(), shareRow(now))
		got, err := NewBunAPIKeyRepository(db).CreateShareLink(ctx, link)
		if err != nil || got.ID != "share-1" {
			t.Fatalf("CreateShareLink = %#v err=%v", got, err)
		}
	})

	t.Run("getByToken", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, shareCols(), shareRow(now))
		got, err := NewBunAPIKeyRepository(db).GetShareLinkByTokenHash(ctx, "hash")
		if err != nil || got.ID != "share-1" {
			t.Fatalf("GetShareLinkByTokenHash = %#v err=%v", got, err)
		}
	})

	t.Run("list", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, shareCols(), shareRow(now))
		got, err := NewBunAPIKeyRepository(db).ListShareLinksByAPIKey(ctx, "key-1")
		if err != nil || len(got) != 1 {
			t.Fatalf("ListShareLinksByAPIKey = %#v err=%v", got, err)
		}
	})

	t.Run("patchActive", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, shareCols(), shareRow(now))
		got, err := NewBunAPIKeyRepository(db).PatchShareLinkActive(ctx, "share-1", false)
		if err != nil || got.ID != "share-1" {
			t.Fatalf("PatchShareLinkActive = %#v err=%v", got, err)
		}
	})

	t.Run("consume", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, shareCols(), shareRow(now))
		got, err := NewBunAPIKeyRepository(db).ConsumeSetupShareLink(ctx, "share-1", now.Format(time.RFC3339))
		if err != nil || got.ID != "share-1" {
			t.Fatalf("ConsumeSetupShareLink = %#v err=%v", got, err)
		}
	})

	t.Run("touch", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		if err := NewBunAPIKeyRepository(db).TouchShareLink(ctx, "share-1"); err != nil {
			t.Fatalf("TouchShareLink: %v", err)
		}
	})

	t.Run("delete", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		ok, err := NewBunAPIKeyRepository(db).DeleteShareLink(ctx, "share-1")
		if err != nil || !ok {
			t.Fatalf("DeleteShareLink = (%v, %v)", ok, err)
		}
	})

	t.Run("db error", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryErr(mock, errors.New("db down"))
		if _, err := NewBunAPIKeyRepository(db).List(ctx); err == nil {
			t.Fatal("expected list error")
		}
	})
}
