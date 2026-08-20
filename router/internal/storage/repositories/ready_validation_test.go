package repositories

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	accounts "github.com/cartethyia/daemon/internal/accounts/auth"
	"github.com/cartethyia/daemon/internal/storage/models"
	"github.com/cartethyia/daemon/internal/telemetry"
	"github.com/cartethyia/daemon/internal/telemetry/usage"
	router "github.com/cartethyia/daemon/internal/router"
	"github.com/uptrace/bun"
)

func closedDB() *bun.DB { return &bun.DB{} }

func TestReadyBanRepository(t *testing.T) {
	ctx := context.Background()
	var nilR *BunBanRepository
	empty := &BunBanRepository{}
	for _, r := range []*BunBanRepository{nilR, empty} {
		_, err := r.IsBanned(ctx, "1.1.1.1")
		mustClosed(t, err)
		_, err = r.GetBan(ctx, "1.1.1.1")
		mustClosed(t, err)
		_, err = r.ListBans(ctx)
		mustClosed(t, err)
		_, err = r.UpsertBan(ctx, models.IPBan{IP: "1.1.1.1"})
		mustClosed(t, err)
		_, err = r.DeleteBan(ctx, "1.1.1.1")
		mustClosed(t, err)
		_, err = r.IncrementOffense(ctx, "1.1.1.1", "auth", "now")
		mustClosed(t, err)
		mustClosed(t, r.ResetOffense(ctx, "1.1.1.1", "auth"))
		_, err = r.ListOffenses(ctx, "1.1.1.1")
		mustClosed(t, err)
	}
}

func TestValidBanRepository(t *testing.T) {
	ctx := context.Background()
	r := &BunBanRepository{db: closedDB()}
	_, err := r.UpsertBan(ctx, models.IPBan{})
	if err == nil || !strings.Contains(err.Error(), "invalid IP") {
		t.Fatalf("UpsertBan empty = %v", err)
	}
	_, err = r.UpsertBan(ctx, models.IPBan{IP: strings.Repeat("1", maxBanText+1), Reason: "x"})
	if err == nil || !strings.Contains(err.Error(), "invalid IP") {
		t.Fatalf("UpsertBan oversized = %v", err)
	}
	_, err = r.IncrementOffense(ctx, "", "auth", "now")
	if err == nil || !strings.Contains(err.Error(), "invalid offense") {
		t.Fatalf("IncrementOffense empty ip = %v", err)
	}
	_, err = r.IncrementOffense(ctx, "1.1.1.1", "", "now")
	if err == nil || !strings.Contains(err.Error(), "invalid offense") {
		t.Fatalf("IncrementOffense empty category = %v", err)
	}
	_, err = r.IncrementOffense(ctx, "1.1.1.1", "auth", "")
	if err == nil || !strings.Contains(err.Error(), "invalid offense") {
		t.Fatalf("IncrementOffense empty now = %v", err)
	}
}

func TestReadyProxyRepository(t *testing.T) {
	ctx := context.Background()
	var nilR *BunProxyRepository
	empty := &BunProxyRepository{}
	now := time.Now().UTC()
	for _, r := range []*BunProxyRepository{nilR, empty} {
		_, err := r.List(ctx)
		mustClosed(t, err)
		_, err = r.Get(ctx, "id")
		mustClosed(t, err)
		_, err = r.Create(ctx, models.ProxyCreateInput{})
		mustClosed(t, err)
		_, err = r.Patch(ctx, "id", models.ProxyPatchInput{})
		mustClosed(t, err)
		_, err = r.RecordTest(ctx, "id", models.ProxyTestResult{})
		mustClosed(t, err)
		_, err = r.Delete(ctx, "id")
		mustClosed(t, err)
		_, err = r.GetSettings(ctx)
		mustClosed(t, err)
		_, err = r.PatchSettings(ctx, models.ProxySettings{})
		mustClosed(t, err)
		_, err = r.GetHealth(ctx, "id")
		mustClosed(t, err)
		mustClosed(t, r.UpsertHealth(ctx, models.ProxyHealth{}))
		_, err = r.RecordHealthFailure(ctx, "id", "kind", "msg", now, time.Second, 1, time.Second, time.Minute)
		mustClosed(t, err)
		mustClosed(t, r.RecordHealthSuccess(ctx, "id", now))
		_, err = r.ClaimHealthProbe(ctx, "id", now, now.Add(time.Minute))
		mustClosed(t, err)
		_, err = r.ListCustomProviders(ctx)
		mustClosed(t, err)
		_, err = r.GetCustomProvider(ctx, "id")
		mustClosed(t, err)
		_, err = r.GetCustomProviderBySlug(ctx, "slug")
		mustClosed(t, err)
		_, err = r.UpsertCustomProvider(ctx, models.CustomProvider{})
		mustClosed(t, err)
		_, err = r.DeleteCustomProvider(ctx, "id")
		mustClosed(t, err)
		_, err = r.ListWarpAccounts(ctx)
		mustClosed(t, err)
		_, err = r.GetWarpAccount(ctx, "id")
		mustClosed(t, err)
		_, err = r.UpsertWarpAccount(ctx, models.WarpAccount{})
		mustClosed(t, err)
		_, err = r.DeleteWarpAccount(ctx, "id")
		mustClosed(t, err)
		mustClosed(t, r.RecordWarpMetric(ctx, models.WarpMetric{}))
	}
}

func TestValidProxyRepository(t *testing.T) {
	ctx := context.Background()
	r := &BunProxyRepository{db: closedDB()}
	_, err := r.Create(ctx, models.ProxyCreateInput{Protocol: "http", Port: 8080, MaxConcurrency: 1, Weight: 1})
	if err == nil || !strings.Contains(err.Error(), "id, name, and host") {
		t.Fatalf("Create missing identity = %v", err)
	}
	_, err = r.Create(ctx, models.ProxyCreateInput{
		ID: "id", Name: "n", Host: "h", Protocol: "ftp", Port: 8080, MaxConcurrency: 1, Weight: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "unsupported protocol") {
		t.Fatalf("Create bad protocol = %v", err)
	}
	_, err = r.Create(ctx, models.ProxyCreateInput{
		ID: "id", Name: "n", Host: "h", Protocol: "http", Port: 0, MaxConcurrency: 1, Weight: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "port") {
		t.Fatalf("Create bad port = %v", err)
	}
	// MaxConcurrency 0 / Weight 0 are rewritten before validate — never call Create with
	// input that passes validation against a hollow bun.DB (panics). Use out-of-bounds only.
	_, err = r.Create(ctx, models.ProxyCreateInput{
		ID: "id", Name: "n", Host: "h", Protocol: "http", Port: 80, MaxConcurrency: 10001, Weight: 1, Priority: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "max concurrency") {
		t.Fatalf("Create bad concurrency = %v", err)
	}
	_, err = r.Create(ctx, models.ProxyCreateInput{
		ID: "id", Name: "n", Host: "h", Protocol: "http", Port: 80, MaxConcurrency: 1, Weight: 1001, Priority: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "weight") {
		t.Fatalf("Create bad weight = %v", err)
	}
	_, err = r.Create(ctx, models.ProxyCreateInput{
		ID: "id", Name: "n", Host: "h", Protocol: "http", Port: 80, MaxConcurrency: 1, Weight: 1, Priority: 100001,
	})
	if err == nil || !strings.Contains(err.Error(), "priority") {
		t.Fatalf("Create bad priority = %v", err)
	}
	_, err = r.Patch(ctx, "   ", models.ProxyPatchInput{})
	if err == nil || !strings.Contains(err.Error(), "id is invalid") {
		t.Fatalf("Patch empty id = %v", err)
	}
	_, err = r.UpsertWarpAccount(ctx, models.WarpAccount{ID: "id"})
	if err == nil || !strings.Contains(err.Error(), "device_id") {
		t.Fatalf("UpsertWarpAccount missing device = %v", err)
	}
	err = r.RecordWarpMetric(ctx, models.WarpMetric{})
	if err == nil || !strings.Contains(err.Error(), "account_id") {
		t.Fatalf("RecordWarpMetric empty = %v", err)
	}
}

func TestReadySettingsRepository(t *testing.T) {
	ctx := context.Background()
	var nilR *BunSettingsRepository
	empty := &BunSettingsRepository{}
	for _, r := range []*BunSettingsRepository{nilR, empty} {
		_, err := r.Ensure(ctx)
		mustClosed(t, err)
		_, err = r.Get(ctx)
		mustClosed(t, err)
		_, err = r.GetSettingsJSON(ctx)
		mustClosed(t, err)
		_, err = r.PatchSettingsJSON(ctx, []byte(`{"a":1}`))
		mustClosed(t, err)
		_, err = r.ResetSettingsJSON(ctx)
		mustClosed(t, err)
		mustClosed(t, r.SetPasswordHash(ctx, "hash"))
		mustClosed(t, r.BumpPasswordVersion(ctx))
		mustClosed(t, r.RotateJWTSecret(ctx, "secret"))
		_, err = r.ListAliases(ctx)
		mustClosed(t, err)
		_, err = r.GetAlias(ctx, "a")
		mustClosed(t, err)
		_, err = r.UpsertAlias(ctx, "a", "m")
		mustClosed(t, err)
		_, err = r.DeleteAlias(ctx, "a")
		mustClosed(t, err)
		_, err = r.ListCombos(ctx)
		mustClosed(t, err)
		_, err = r.GetCombo(ctx, "id")
		mustClosed(t, err)
		_, err = r.UpsertCombo(ctx, models.Combo{ID: "id", Name: "n"})
		mustClosed(t, err)
		_, err = r.DeleteCombo(ctx, "id")
		mustClosed(t, err)
		_, err = r.GetAccessRule(ctx, "scope")
		mustClosed(t, err)
		_, err = r.UpsertAccessRule(ctx, models.AccessRule{Scope: "scope"})
		mustClosed(t, err)
		_, err = r.ListProviderModels(ctx, "")
		mustClosed(t, err)
		_, err = r.GetProviderModel(ctx, "p", "m")
		mustClosed(t, err)
		_, err = r.UpsertProviderModel(ctx, models.ProviderModel{Provider: "p", ModelID: "m"})
		mustClosed(t, err)
		_, err = r.DeleteProviderModel(ctx, "p", "m")
		mustClosed(t, err)
		_, err = r.ListCliMappings(ctx, "")
		mustClosed(t, err)
		_, err = r.UpsertCliMapping(ctx, models.CliModelMapping{ToolID: "t", SlotKey: "s"})
		mustClosed(t, err)
		_, err = r.DeleteCliMapping(ctx, "t", "s")
		mustClosed(t, err)
		_, err = r.GetCliMappingSettings(ctx, "t")
		mustClosed(t, err)
		_, err = r.SetCliMappingEnabled(ctx, "t", true)
		mustClosed(t, err)
		mustClosed(t, r.ResetCliMappings(ctx, "t"))
		_, err = r.ListFilterRules(ctx)
		mustClosed(t, err)
		_, err = r.UpsertFilterRule(ctx, models.FilterRule{RuleID: "r"})
		mustClosed(t, err)
		_, err = r.DeleteFilterRule(ctx, 1)
		mustClosed(t, err)
	}
}

func TestValidSettingsRepository(t *testing.T) {
	ctx := context.Background()
	r := &BunSettingsRepository{db: closedDB()}

	_, err := r.PatchSettingsJSON(ctx, nil)
	if err == nil || !strings.Contains(err.Error(), "JSON patch") {
		t.Fatalf("PatchSettingsJSON empty = %v", err)
	}
	_, err = r.PatchSettingsJSON(ctx, []byte("[]"))
	if err == nil || !strings.Contains(err.Error(), "object") {
		t.Fatalf("PatchSettingsJSON array = %v", err)
	}
	_, err = r.PatchSettingsJSON(ctx, []byte("{"))
	if err == nil || !strings.Contains(err.Error(), "object") {
		t.Fatalf("PatchSettingsJSON invalid = %v", err)
	}
	_, err = r.PatchSettingsJSON(ctx, make([]byte, maxSettingsJSON+1))
	if err == nil || !strings.Contains(err.Error(), "JSON patch") {
		t.Fatalf("PatchSettingsJSON oversized = %v", err)
	}

	err = r.SetPasswordHash(ctx, strings.Repeat("h", maxSettingsText+1))
	if err == nil || !strings.Contains(err.Error(), "password hash") {
		t.Fatalf("SetPasswordHash oversized = %v", err)
	}
	err = r.RotateJWTSecret(ctx, strings.Repeat("s", maxSettingsText+1))
	if err == nil || !strings.Contains(err.Error(), "JWT secret") {
		t.Fatalf("RotateJWTSecret oversized = %v", err)
	}

	var nilR *BunSettingsRepository
	_, err = nilR.UpsertAlias(ctx, "", "model")
	if err == nil || !strings.Contains(err.Error(), "required and bounded") {
		t.Fatalf("UpsertAlias empty = %v", err)
	}
	_, err = r.UpsertAlias(ctx, "alias", "")
	if err == nil || !strings.Contains(err.Error(), "required and bounded") {
		t.Fatalf("UpsertAlias empty model = %v", err)
	}
	_, err = r.UpsertAlias(ctx, strings.Repeat("a", maxSettingsText+1), "m")
	if err == nil || !strings.Contains(err.Error(), "required and bounded") {
		t.Fatalf("UpsertAlias oversized = %v", err)
	}

	_, err = r.UpsertCombo(ctx, models.Combo{})
	if err == nil || !strings.Contains(err.Error(), "invalid combo") {
		t.Fatalf("UpsertCombo empty = %v", err)
	}
	_, err = r.UpsertCombo(ctx, models.Combo{ID: "id", Name: "n", Models: make([]string, 257)})
	if err == nil || !strings.Contains(err.Error(), "invalid combo") {
		t.Fatalf("UpsertCombo too many models = %v", err)
	}

	_, err = r.UpsertAccessRule(ctx, models.AccessRule{})
	if err == nil || !strings.Contains(err.Error(), "invalid access rule") {
		t.Fatalf("UpsertAccessRule empty = %v", err)
	}
	_, err = r.UpsertAccessRule(ctx, models.AccessRule{Scope: "s", Entries: make([]byte, maxSettingsJSON+1)})
	if err == nil || !strings.Contains(err.Error(), "invalid access rule") {
		t.Fatalf("UpsertAccessRule oversized = %v", err)
	}

	_, err = r.UpsertProviderModel(ctx, models.ProviderModel{})
	if err == nil || !strings.Contains(err.Error(), "invalid provider model") {
		t.Fatalf("UpsertProviderModel empty = %v", err)
	}
	_, err = r.UpsertCliMapping(ctx, models.CliModelMapping{})
	if err == nil || !strings.Contains(err.Error(), "invalid CLI mapping") {
		t.Fatalf("UpsertCliMapping empty = %v", err)
	}
	_, err = r.SetCliMappingEnabled(ctx, "", true)
	if err == nil || !strings.Contains(err.Error(), "invalid CLI tool") {
		t.Fatalf("SetCliMappingEnabled empty = %v", err)
	}
	_, err = r.UpsertFilterRule(ctx, models.FilterRule{})
	if err == nil || !strings.Contains(err.Error(), "invalid filter rule") {
		t.Fatalf("UpsertFilterRule empty = %v", err)
	}
	_, err = r.UpsertFilterRule(ctx, models.FilterRule{RuleID: "r", Pattern: strings.Repeat("p", maxSettingsJSON+1)})
	if err == nil || !strings.Contains(err.Error(), "invalid filter rule") {
		t.Fatalf("UpsertFilterRule oversized = %v", err)
	}
}

func TestReadyCatalogRepository(t *testing.T) {
	ctx := context.Background()
	var nilR *BunCatalogRepository
	empty := &BunCatalogRepository{}
	for _, r := range []*BunCatalogRepository{nilR, empty} {
		_, err := r.ListAliases(ctx)
		mustClosed(t, err)
		_, err = r.ListCombos(ctx)
		mustClosed(t, err)
		_, err = r.ListProviderModels(ctx, "")
		mustClosed(t, err)
		mustClosed(t, r.PutAlias(ctx, models.ModelAlias{Alias: "a", Model: "m"}))
		mustClosed(t, r.PutCombo(ctx, models.Combo{ID: "id", Name: "n"}))
		mustClosed(t, r.DeleteAlias(ctx, "a"))
		mustClosed(t, r.DeleteCombo(ctx, "id"))
	}
}

func TestReadyAPIKeyRepository(t *testing.T) {
	ctx := context.Background()
	var nilR *BunAPIKeyRepository
	empty := &BunAPIKeyRepository{}
	for _, r := range []*BunAPIKeyRepository{nilR, empty} {
		_, err := r.List(ctx)
		mustClosed(t, err)
		_, err = r.GetByID(ctx, "id")
		mustClosed(t, err)
		_, err = r.GetBySecret(ctx, "secret")
		mustClosed(t, err)
		_, err = r.Credential(ctx, "id")
		mustClosed(t, err)
		_, err = r.Create(ctx, models.ApiKeyCreateInput{ID: "id", Name: "n", Key: "secret"})
		mustClosed(t, err)
		_, err = r.Patch(ctx, "id", models.ApiKeyPatchInput{})
		mustClosed(t, err)
		_, err = r.Revoke(ctx, "id")
		mustClosed(t, err)
		_, err = r.Delete(ctx, "id")
		mustClosed(t, err)
		mustClosed(t, r.Touch(ctx, "id"))
		mustClosed(t, r.FlushTouches(ctx))
		_, err = r.CreateShareLink(ctx, models.ShareLink{ID: "id", APIKeyID: "k", TokenHash: "h", Kind: "setup"})
		mustClosed(t, err)
		_, err = r.GetShareLinkByTokenHash(ctx, "hash")
		mustClosed(t, err)
		_, err = r.ListShareLinksByAPIKey(ctx, "id")
		mustClosed(t, err)
		_, err = r.PatchShareLinkActive(ctx, "id", true)
		mustClosed(t, err)
		_, err = r.ConsumeSetupShareLink(ctx, "id", time.Now().UTC().Format(time.RFC3339))
		mustClosed(t, err)
		mustClosed(t, r.TouchShareLink(ctx, "id"))
		_, err = r.DeleteShareLink(ctx, "id")
		mustClosed(t, err)
	}
}

func TestValidAPIKeyRepository(t *testing.T) {
	ctx := context.Background()
	r := &BunAPIKeyRepository{db: closedDB(), pending: map[string]struct{}{}}

	_, err := r.GetByID(ctx, "")
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("GetByID empty = %v", err)
	}
	_, err = r.GetByID(ctx, strings.Repeat("i", maxAPIKeyID+1))
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("GetByID oversized = %v", err)
	}
	_, err = r.GetBySecret(ctx, "")
	if err == nil || !strings.Contains(err.Error(), "credential") {
		t.Fatalf("GetBySecret empty = %v", err)
	}
	_, err = r.GetBySecret(ctx, strings.Repeat("s", maxAPIKeySecret+1))
	if err == nil || !strings.Contains(err.Error(), "credential") {
		t.Fatalf("GetBySecret oversized = %v", err)
	}
	_, err = r.Credential(ctx, "  ")
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("Credential empty = %v", err)
	}

	_, err = r.Create(ctx, models.ApiKeyCreateInput{Name: "n", Key: "secret"})
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("Create empty id = %v", err)
	}
	_, err = r.Create(ctx, models.ApiKeyCreateInput{ID: "id", Key: "secret"})
	if err == nil || !strings.Contains(err.Error(), "name is required") {
		t.Fatalf("Create empty name = %v", err)
	}
	_, err = r.Create(ctx, models.ApiKeyCreateInput{ID: "id", Name: "n"})
	if err == nil || !strings.Contains(err.Error(), "credential") {
		t.Fatalf("Create empty key = %v", err)
	}
	badLimit := -1
	_, err = r.Create(ctx, models.ApiKeyCreateInput{ID: "id", Name: "n", Key: "secret", RateLimitRpm: &badLimit})
	if err == nil || !strings.Contains(err.Error(), "numeric limit") {
		t.Fatalf("Create bad limit = %v", err)
	}
	huge := maxTokenDelta + 1
	_, err = r.Create(ctx, models.ApiKeyCreateInput{ID: "id", Name: "n", Key: "secret", DailyTokenLimit: &huge})
	if err == nil || !strings.Contains(err.Error(), "numeric limit") {
		t.Fatalf("Create huge limit = %v", err)
	}

	_, err = r.Patch(ctx, "", models.ApiKeyPatchInput{})
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("Patch empty id = %v", err)
	}
	emptyName := "  "
	_, err = r.Patch(ctx, "id", models.ApiKeyPatchInput{Name: &emptyName})
	if err == nil || !strings.Contains(err.Error(), "name is required") {
		t.Fatalf("Patch empty name = %v", err)
	}
	emptyKey := ""
	_, err = r.Patch(ctx, "id", models.ApiKeyPatchInput{Key: &emptyKey})
	if err == nil || !strings.Contains(err.Error(), "credential") {
		t.Fatalf("Patch empty key = %v", err)
	}
	bigText := strings.Repeat("t", maxAPIKeyText+1)
	_, err = r.Patch(ctx, "id", models.ApiKeyPatchInput{QuoteBody: &bigText})
	if err == nil || !strings.Contains(err.Error(), "text is bounded") {
		t.Fatalf("Patch oversized text = %v", err)
	}
	_, err = r.Patch(ctx, "id", models.ApiKeyPatchInput{RateLimitRpm: &badLimit})
	if err == nil || !strings.Contains(err.Error(), "numeric limit") {
		t.Fatalf("Patch bad limit = %v", err)
	}

	_, err = r.Revoke(ctx, "")
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("Revoke empty = %v", err)
	}
	_, err = r.Delete(ctx, "")
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("Delete empty = %v", err)
	}
	err = r.Touch(ctx, "")
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("Touch empty = %v", err)
	}

	_, err = r.CreateShareLink(ctx, models.ShareLink{})
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("CreateShareLink empty id = %v", err)
	}
	_, err = r.CreateShareLink(ctx, models.ShareLink{ID: "id"})
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("CreateShareLink empty api key = %v", err)
	}
	_, err = r.CreateShareLink(ctx, models.ShareLink{ID: "id", APIKeyID: "k"})
	if err == nil || !strings.Contains(err.Error(), "token hash") {
		t.Fatalf("CreateShareLink empty hash = %v", err)
	}
	_, err = r.CreateShareLink(ctx, models.ShareLink{ID: "id", APIKeyID: "k", TokenHash: "h"})
	if err == nil || !strings.Contains(err.Error(), "kind") {
		t.Fatalf("CreateShareLink empty kind = %v", err)
	}
	_, err = r.GetShareLinkByTokenHash(ctx, "")
	if err == nil || !strings.Contains(err.Error(), "token hash") {
		t.Fatalf("GetShareLinkByTokenHash empty = %v", err)
	}
	_, err = r.ListShareLinksByAPIKey(ctx, "")
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("ListShareLinksByAPIKey empty = %v", err)
	}
	_, err = r.PatchShareLinkActive(ctx, "", true)
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("PatchShareLinkActive empty = %v", err)
	}
	_, err = r.ConsumeSetupShareLink(ctx, "", "now")
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("ConsumeSetupShareLink empty = %v", err)
	}
	err = r.TouchShareLink(ctx, "")
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("TouchShareLink empty = %v", err)
	}
	_, err = r.DeleteShareLink(ctx, "")
	if err == nil || !strings.Contains(err.Error(), "id is required") {
		t.Fatalf("DeleteShareLink empty = %v", err)
	}
}

func TestReadyPublicAPIKeyResolver(t *testing.T) {
	ctx := context.Background()
	var nilR *BunPublicAPIKeyResolver
	empty := &BunPublicAPIKeyResolver{}
	for _, r := range []*BunPublicAPIKeyResolver{nilR, empty} {
		_, err := r.ResolveAPIKey(ctx, "secret")
		if err == nil || !strings.Contains(err.Error(), "unavailable") {
			t.Fatalf("ResolveAPIKey closed = %v", err)
		}
		err = r.TouchAPIKey(ctx, "id")
		if err == nil || !strings.Contains(err.Error(), "unavailable") {
			t.Fatalf("TouchAPIKey closed = %v", err)
		}
	}
}

func TestValidPublicAPIKeyResolver(t *testing.T) {
	ctx := context.Background()
	r := &BunPublicAPIKeyResolver{db: closedDB()}
	_, err := r.ResolveAPIKey(ctx, "")
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("ResolveAPIKey empty = %v", err)
	}
}

func TestReadyCustomProviderRepository(t *testing.T) {
	ctx := context.Background()
	var nilR *BunCustomProviderRepository
	empty := &BunCustomProviderRepository{}
	for _, r := range []*BunCustomProviderRepository{nilR, empty} {
		_, err := r.ListCustomProviders(ctx)
		mustClosed(t, err)
		_, err = r.GetCustomProvider(ctx, "id")
		mustClosed(t, err)
		_, err = r.GetCustomProviderBySlug(ctx, "slug")
		mustClosed(t, err)
		_, err = r.UpsertCustomProvider(ctx, models.CustomProvider{})
		mustClosed(t, err)
		_, err = r.DeleteCustomProvider(ctx, "id")
		mustClosed(t, err)
	}
}

func TestValidCustomProviderRepository(t *testing.T) {
	ctx := context.Background()
	r := &BunCustomProviderRepository{db: closedDB()}
	_, err := r.UpsertCustomProvider(ctx, models.CustomProvider{})
	if err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("Upsert missing fields = %v", err)
	}
	_, err = r.UpsertCustomProvider(ctx, models.CustomProvider{
		ID: "id", Slug: "slug", Name: "n", BaseURL: "https://x", Type: "unknown", CredentialRef: "ref",
	})
	if err == nil || !strings.Contains(err.Error(), "unsupported custom provider type") {
		t.Fatalf("Upsert bad type = %v", err)
	}
	_, err = r.UpsertCustomProvider(ctx, models.CustomProvider{
		ID: "id", Slug: "slug", Name: "n", BaseURL: "https://x", Type: "openai-compatible",
		Protocol: "openai", Surface: "anthropic-messages", CredentialRef: "ref",
	})
	if err == nil || !strings.Contains(err.Error(), "protocol/surface") {
		t.Fatalf("Upsert bad surface = %v", err)
	}
	_, err = r.UpsertCustomProvider(ctx, models.CustomProvider{
		ID: "id", Slug: "slug", Name: "n", BaseURL: "https://x", Type: "openai-compatible",
	})
	if err == nil || !strings.Contains(err.Error(), "credential_ref") {
		t.Fatalf("Upsert missing credential = %v", err)
	}
}

func TestReadyTelemetryRepository(t *testing.T) {
	ctx := context.Background()
	var nilR *BunTelemetryRepository
	empty := &BunTelemetryRepository{}
	for _, r := range []*BunTelemetryRepository{nilR, empty} {
		_, err := r.InsertRequest(ctx, models.RequestHistory{TraceID: "t", Endpoint: "e", Surface: "s"})
		mustClosed(t, err)
		_, err = r.GetRequest(ctx, 1)
		mustClosed(t, err)
		_, err = r.GetRequestByTrace(ctx, "t")
		mustClosed(t, err)
		_, err = r.ListRequestsByAPIKey(ctx, "k", 10)
		mustClosed(t, err)
		_, err = r.ShareUsage(ctx, "k", time.Now().UTC())
		mustClosed(t, err)
		_, err = r.ListRequestsOlderThan(ctx, "2020-01-01", 10)
		mustClosed(t, err)
		_, err = r.DeleteRequestsOlderThan(ctx, "2020-01-01")
		mustClosed(t, err)
		_, err = r.UpsertPayload(ctx, models.RequestPayload{RequestID: "r"})
		mustClosed(t, err)
		_, err = r.GetPayload(ctx, "r")
		mustClosed(t, err)
		_, err = r.DeletePayloadsOlderThan(ctx, "2020-01-01")
		mustClosed(t, err)
		mustClosed(t, r.InsertConsoleLog(ctx, models.ConsoleLog{Level: "info", Scope: "s", Message: "m"}))
		_, err = r.ListConsoleLogs(ctx, "s", 10)
		mustClosed(t, err)
		_, err = r.DeleteConsoleLogsOlderThan(ctx, "2020-01-01")
		mustClosed(t, err)
	}
	mustClosed(t, (*MetadataSinkAdapter)(nil).WriteMetadata(ctx, telemetry.Metadata{}))
	mustClosed(t, (&MetadataSinkAdapter{}).WriteMetadata(ctx, telemetry.Metadata{}))
}

func TestValidTelemetryRepository(t *testing.T) {
	ctx := context.Background()
	r := &BunTelemetryRepository{db: closedDB()}

	_, err := r.InsertRequest(ctx, models.RequestHistory{})
	if err == nil || !strings.Contains(err.Error(), "trace_id, endpoint, and surface") {
		t.Fatalf("InsertRequest empty = %v", err)
	}
	_, err = r.InsertRequest(ctx, models.RequestHistory{
		TraceID: "t", Endpoint: "e", Surface: "s", MetaJSON: make([]byte, maxTelemetryMeta+1),
	})
	if err == nil || !strings.Contains(err.Error(), "metadata exceeds") {
		t.Fatalf("InsertRequest oversized meta = %v", err)
	}
	_, err = r.ShareUsage(ctx, "  ", time.Now().UTC())
	if err == nil || !strings.Contains(err.Error(), "api key id") {
		t.Fatalf("ShareUsage empty = %v", err)
	}
	_, err = r.UpsertPayload(ctx, models.RequestPayload{})
	if err == nil || !strings.Contains(err.Error(), "request_id") {
		t.Fatalf("UpsertPayload empty = %v", err)
	}
	_, err = r.UpsertPayload(ctx, models.RequestPayload{
		RequestID: "r", ClientRequest: make([]byte, maxTelemetryPayload+1),
	})
	if err == nil || !strings.Contains(err.Error(), "payload exceeds") {
		t.Fatalf("UpsertPayload oversized = %v", err)
	}
	err = r.InsertConsoleLog(ctx, models.ConsoleLog{})
	if err == nil || !strings.Contains(err.Error(), "level, scope, and message") {
		t.Fatalf("InsertConsoleLog empty = %v", err)
	}
}

func TestReadyRefreshLeaseStore(t *testing.T) {
	ctx := context.Background()
	var nilR *BunRefreshLeaseStore
	empty := &BunRefreshLeaseStore{}
	for _, r := range []*BunRefreshLeaseStore{nilR, empty} {
		_, _, err := r.Acquire(ctx, "acc", "owner", time.Minute)
		mustClosed(t, err)
		_, err = r.Renew(ctx, "acc", accounts.RefreshFence{OwnerID: "o", Generation: 1}, time.Minute)
		mustClosed(t, err)
	}
}

func TestValidRefreshLeaseStore(t *testing.T) {
	ctx := context.Background()
	r := &BunRefreshLeaseStore{db: closedDB()}
	_, _, err := r.Acquire(ctx, "", "owner", time.Minute)
	if err == nil || !strings.Contains(err.Error(), "account and owner") {
		t.Fatalf("Acquire empty account = %v", err)
	}
	_, _, err = r.Acquire(ctx, "acc", "owner", 0)
	if err == nil || !strings.Contains(err.Error(), "ttl") {
		t.Fatalf("Acquire zero ttl = %v", err)
	}
	_, err = r.Renew(ctx, "acc", accounts.RefreshFence{}, time.Minute)
	if err == nil || !strings.Contains(err.Error(), "account, owner, and generation") {
		t.Fatalf("Renew empty fence = %v", err)
	}
	_, err = r.Renew(ctx, "acc", accounts.RefreshFence{OwnerID: "o", Generation: 1}, 0)
	if err == nil || !strings.Contains(err.Error(), "ttl") {
		t.Fatalf("Renew zero ttl = %v", err)
	}
}

func TestReadyTokenBudgetRepository(t *testing.T) {
	ctx := context.Background()
	req := router.ReservationRequest{
		KeyID: "key", RequestID: "req", Attempt: 1, WindowUTC: time.Now().UTC(), Estimate: 10,
	}
	var nilR *BunTokenBudgetRepository
	empty := &BunTokenBudgetRepository{}
	for _, r := range []*BunTokenBudgetRepository{nilR, empty} {
		_, err := r.Reserve(ctx, req)
		if !errors.Is(err, router.ErrUnavailable) {
			t.Fatalf("Reserve closed = %v", err)
		}
		_, err = r.RecoverExpired(ctx, time.Now().UTC(), 10)
		if !errors.Is(err, router.ErrUnavailable) {
			t.Fatalf("RecoverExpired closed = %v", err)
		}
	}
	var nilRes *durableReservation
	if err := nilRes.Reconcile(ctx, struct {
		Input, Output, CachedRead, CachedWrite, Reasoning, Total *int64
	}{}); !errors.Is(err, router.ErrUnavailable) {
		// use proper usage.Tokens zero value below
	}
}

func TestReadyTokenBudgetRepositoryHandles(t *testing.T) {
	ctx := context.Background()
	req := router.ReservationRequest{
		KeyID: "key", RequestID: "req", Attempt: 1, WindowUTC: time.Now().UTC(), Estimate: 10,
	}
	var nilR *BunTokenBudgetRepository
	_, err := nilR.Reserve(ctx, req)
	if !errors.Is(err, router.ErrUnavailable) {
		t.Fatalf("nil Reserve = %v", err)
	}
	_, err = (&BunTokenBudgetRepository{}).Reserve(ctx, req)
	if !errors.Is(err, router.ErrUnavailable) {
		t.Fatalf("empty Reserve = %v", err)
	}
	_, err = (&BunTokenBudgetRepository{}).RecoverExpired(ctx, time.Now().UTC(), 1)
	if !errors.Is(err, router.ErrUnavailable) {
		t.Fatalf("empty RecoverExpired = %v", err)
	}

	var nilHandle *durableReservation
	if err := nilHandle.Reconcile(ctx, usage.Tokens{}); !errors.Is(err, router.ErrUnavailable) {
		t.Fatalf("nil Reconcile = %v", err)
	}
	if err := (&durableReservation{}).Reconcile(ctx, usage.Tokens{}); !errors.Is(err, router.ErrUnavailable) {
		t.Fatalf("empty Reconcile = %v", err)
	}
	if err := nilHandle.Release(ctx, router.ReleaseUnaccepted); !errors.Is(err, router.ErrUnavailable) {
		t.Fatalf("nil Release = %v", err)
	}
	if err := (&durableReservation{repository: &BunTokenBudgetRepository{}}).Release(ctx, router.ReleaseUnaccepted); !errors.Is(err, router.ErrUnavailable) {
		t.Fatalf("closed Release = %v", err)
	}
}
