package repositories

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/storage/models"
)

func settingsAdminCols() []string {
	return []string{"password_hash", "password_version", "jwt_secret", "settings_json", "initialized_at", "updated_at"}
}

func settingsAdminRow(now time.Time) []any {
	return []any{nil, 1, nil, []byte(`{}`), now, now}
}

func warpCols() []string {
	return []string{
		"id", "label", "device_id", "access_token", "license_key", "private_key", "address_v4", "address_v6",
		"public_key", "endpoint", "endpoint_port", "dns", "mtu", "socks_port", "enabled", "running", "pid",
		"prefer_ipv6", "custom_endpoint", "persistent_keepalive", "created_at", "updated_at",
	}
}

func warpRow(now time.Time) []any {
	return []any{
		"w1", "lab", "device", "token", "license", "priv", "1.1.1.1", "::1", "pub", "ep", 2408,
		"1.1.1.1", 1280, 1080, true, true, nil, false, nil, 25, now, now,
	}
}

func customProviderCols() []string {
	return []string{
		"id", "slug", "name", "type", "protocol", "surface", "base_url", "credential_ref",
		"credential_refs_json", "timeout_seconds", "models_json", "headers_json", "created_at", "updated_at",
	}
}

func customProviderRowValues(now time.Time) []any {
	return []any{
		"c1", "slug", "Name", "openai-compatible", "openai", "openai-chat", "https://example.com", "cred-1",
		[]byte(`["cred-1"]`), 30, []byte(`[]`), []byte(`{}`), now, now,
	}
}

func TestSettingsSQLMockEnsureGetPatch(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

	t.Run("ensure", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, settingsAdminCols(), settingsAdminRow(now))
		got, err := NewBunSettingsRepository(db).Ensure(ctx)
		if err != nil || got.PasswordVersion != 1 {
			t.Fatalf("Ensure = %#v err=%v", got, err)
		}
	})

	t.Run("get", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, settingsAdminCols(), settingsAdminRow(now))
		got, err := NewBunSettingsRepository(db).Get(ctx)
		if err != nil || got.PasswordVersion != 1 {
			t.Fatalf("Get = %#v err=%v", got, err)
		}
	})

	t.Run("patch json", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, settingsAdminCols(), settingsAdminRow(now))
		expectAnyExec(mock, nil)
		patch := []byte(`{"theme":"dark"}`)
		got, err := NewBunSettingsRepository(db).PatchSettingsJSON(ctx, patch)
		if err != nil || string(got) != string(patch) {
			t.Fatalf("PatchSettingsJSON = %s err=%v", got, err)
		}
	})

	t.Run("closed", func(t *testing.T) {
		var repo *BunSettingsRepository
		if _, err := repo.Get(ctx); err != ErrRepositoryClosed {
			t.Fatalf("Get closed = %v", err)
		}
	})

	t.Run("reset", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		got, err := NewBunSettingsRepository(db).ResetSettingsJSON(ctx)
		if err != nil || string(got) != "{}" {
			t.Fatalf("ResetSettingsJSON = %s err=%v", got, err)
		}
	})

	t.Run("password and jwt", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		repo := NewBunSettingsRepository(db)
		if err := repo.SetPasswordHash(ctx, "hash"); err != nil {
			t.Fatalf("SetPasswordHash: %v", err)
		}
		if err := repo.BumpPasswordVersion(ctx); err != nil {
			t.Fatalf("BumpPasswordVersion: %v", err)
		}
		if err := repo.RotateJWTSecret(ctx, "secret"); err != nil {
			t.Fatalf("RotateJWTSecret: %v", err)
		}
	})

	t.Run("list aliases", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, []string{"alias", "model", "created_at"}, []any{"fast", "gpt-4o-mini", now})
		got, err := NewBunSettingsRepository(db).ListAliases(ctx)
		if err != nil || len(got) != 1 || got[0].Alias != "fast" {
			t.Fatalf("ListAliases = %#v err=%v", got, err)
		}
	})
}

func TestWarpSQLMockCRUD(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	repo := func(t *testing.T) *BunProxyRepository {
		t.Helper()
		db, _ := newFakeBun(t)
		return NewBunProxyRepository(db)
	}

	t.Run("list", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, warpCols(), warpRow(now))
		got, err := NewBunProxyRepository(db).ListWarpAccounts(ctx)
		if err != nil || len(got) != 1 || got[0].ID != "w1" {
			t.Fatalf("ListWarpAccounts = %#v err=%v", got, err)
		}
	})

	t.Run("get", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, warpCols(), warpRow(now))
		got, err := NewBunProxyRepository(db).GetWarpAccount(ctx, "w1")
		if err != nil || got.ID != "w1" {
			t.Fatalf("GetWarpAccount = %#v err=%v", got, err)
		}
	})

	t.Run("upsert", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, warpCols(), warpRow(now))
		got, err := NewBunProxyRepository(db).UpsertWarpAccount(ctx, models.WarpAccount{ID: "w1", DeviceID: "device"})
		if err != nil || got.ID != "w1" {
			t.Fatalf("UpsertWarpAccount = %#v err=%v", got, err)
		}
	})

	t.Run("delete", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		ok, err := NewBunProxyRepository(db).DeleteWarpAccount(ctx, "w1")
		if err != nil || !ok {
			t.Fatalf("DeleteWarpAccount = (%v, %v)", ok, err)
		}
	})

	t.Run("metric", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		if err := NewBunProxyRepository(db).RecordWarpMetric(ctx, models.WarpMetric{AccountID: "w1", CollectedAt: now}); err != nil {
			t.Fatalf("RecordWarpMetric: %v", err)
		}
	})

	t.Run("validation", func(t *testing.T) {
		if _, err := repo(t).UpsertWarpAccount(ctx, models.WarpAccount{}); err == nil {
			t.Fatal("expected validation error")
		}
		if err := repo(t).RecordWarpMetric(ctx, models.WarpMetric{}); err == nil {
			t.Fatal("expected metric validation error")
		}
	})
}

func TestCustomProviderSQLMockCRUD(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

	t.Run("list", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, customProviderCols(), customProviderRowValues(now))
		got, err := NewBunCustomProviderRepository(db).ListCustomProviders(ctx)
		if err != nil || len(got) != 1 || got[0].ID != "c1" {
			t.Fatalf("ListCustomProviders = %#v err=%v", got, err)
		}
	})

	t.Run("get", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, customProviderCols(), customProviderRowValues(now))
		got, err := NewBunCustomProviderRepository(db).GetCustomProvider(ctx, "c1")
		if err != nil || got.Slug != "slug" {
			t.Fatalf("GetCustomProvider = %#v err=%v", got, err)
		}
	})

	t.Run("getBySlug", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, customProviderCols(), customProviderRowValues(now))
		got, err := NewBunCustomProviderRepository(db).GetCustomProviderBySlug(ctx, "slug")
		if err != nil || got.ID != "c1" {
			t.Fatalf("GetCustomProviderBySlug = %#v err=%v", got, err)
		}
	})

	t.Run("upsert", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, customProviderCols(), customProviderRowValues(now))
		got, err := NewBunCustomProviderRepository(db).UpsertCustomProvider(ctx, models.CustomProvider{
			ID: "c1", Slug: "slug", Name: "Name", Type: "openai-compatible", BaseURL: "https://example.com", CredentialRef: "cred-1",
		})
		if err != nil || got.ID != "c1" {
			t.Fatalf("UpsertCustomProvider = %#v err=%v", got, err)
		}
	})

	t.Run("delete", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		ok, err := NewBunCustomProviderRepository(db).DeleteCustomProvider(ctx, "c1")
		if err != nil || !ok {
			t.Fatalf("DeleteCustomProvider = (%v, %v)", ok, err)
		}
	})

	t.Run("proxy delegation", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, customProviderCols(), customProviderRowValues(now))
		got, err := NewBunProxyRepository(db).ListCustomProviders(ctx)
		if err != nil || len(got) != 1 {
			t.Fatalf("proxy ListCustomProviders = %#v err=%v", got, err)
		}
	})

	t.Run("db error", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryErr(mock, errors.New("db down"))
		if _, err := NewBunCustomProviderRepository(db).ListCustomProviders(ctx); err == nil {
			t.Fatal("expected list error")
		}
	})
}

func TestSettingsCombosAndAccessSQLMock(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

	t.Run("combos", func(t *testing.T) {
		db, mock := newFakeBun(t)
		repo := NewBunSettingsRepository(db)
		expectAnyQueryRows(mock, []string{"id", "name", "models_json", "strategy", "sticky_limit", "created_at", "updated_at"}, []any{"c1", "combo", []byte(`["m1"]`), "round_robin", 2, now, now})
		got, err := repo.ListCombos(ctx)
		if err != nil || len(got) != 1 || got[0].ID != "c1" {
			t.Fatalf("ListCombos = %#v err=%v", got, err)
		}
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, []string{"id", "name", "models_json", "strategy", "sticky_limit", "created_at", "updated_at"}, []any{"c1", "combo", []byte(`["m1"]`), "round_robin", 2, now, now})
		upserted, err := repo.UpsertCombo(ctx, models.Combo{ID: "c1", Name: "combo", Models: []string{"m1"}, Strategy: "round_robin", StickyLimit: 2})
		if err != nil || upserted.ID != "c1" {
			t.Fatalf("UpsertCombo = %#v err=%v", upserted, err)
		}
		expectAnyExec(mock, nil)
		ok, err := repo.DeleteCombo(ctx, "c1")
		if err != nil || !ok {
			t.Fatalf("DeleteCombo = (%v, %v)", ok, err)
		}
	})

	t.Run("access rule", func(t *testing.T) {
		db, mock := newFakeBun(t)
		repo := NewBunSettingsRepository(db)
		expectAnyQueryRows(mock, []string{"scope", "mode", "entries_json", "updated_at"}, []any{"admin", "allow", []byte(`[]`), now})
		got, err := repo.GetAccessRule(ctx, "admin")
		if err != nil || got.Scope != "admin" {
			t.Fatalf("GetAccessRule = %#v err=%v", got, err)
		}
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, []string{"scope", "mode", "entries_json", "updated_at"}, []any{"admin", "deny", []byte(`[]`), now})
		upserted, err := repo.UpsertAccessRule(ctx, models.AccessRule{Scope: "admin", Mode: "deny", Entries: []byte(`[]`)})
		if err != nil || upserted.Mode != "deny" {
			t.Fatalf("UpsertAccessRule = %#v err=%v", upserted, err)
		}
	})

	t.Run("provider models", func(t *testing.T) {
		db, mock := newFakeBun(t)
		repo := NewBunSettingsRepository(db)
		expectAnyQueryRows(mock, []string{"provider", "model_id", "enabled", "source", "created_at", "updated_at"}, []any{"openai", "gpt-4o-mini", true, "builtin", now, now})
		got, err := repo.ListProviderModels(ctx, "openai")
		if err != nil || len(got) != 1 {
			t.Fatalf("ListProviderModels = %#v err=%v", got, err)
		}
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, []string{"provider", "model_id", "enabled", "source", "created_at", "updated_at"}, []any{"openai", "gpt-4o-mini", true, "builtin", now, now})
		upserted, err := repo.UpsertProviderModel(ctx, models.ProviderModel{Provider: "openai", ModelID: "gpt-4o-mini", Enabled: true, Source: "builtin"})
		if err != nil || upserted.ModelID != "gpt-4o-mini" {
			t.Fatalf("UpsertProviderModel = %#v err=%v", upserted, err)
		}
	})

	t.Run("delete alias", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		ok, err := NewBunSettingsRepository(db).DeleteAlias(ctx, "fast")
		if err != nil || !ok {
			t.Fatalf("DeleteAlias = (%v, %v)", ok, err)
		}
	})
}
