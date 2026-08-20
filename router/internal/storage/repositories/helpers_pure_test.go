package repositories

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	accounts "github.com/cartethyia/daemon/internal/accounts/auth"
	"github.com/cartethyia/daemon/internal/storage/models"
	"github.com/cartethyia/daemon/internal/telemetry"
	"github.com/cartethyia/daemon/internal/telemetry/usage"
	router "github.com/cartethyia/daemon/internal/router"
)

func TestMergeJSONObjectsNilDeleteAndNested(t *testing.T) {
	dst := map[string]any{
		"keep":   "yes",
		"remove": "bye",
		"nested": map[string]any{"a": 1.0, "b": 2.0},
		"leaf":   "old",
	}
	mergeJSONObjects(dst, map[string]any{
		"remove": nil,
		"nested": map[string]any{"b": nil, "c": 3.0},
		"leaf":   "new",
		"fresh":  map[string]any{"x": true},
	})
	if _, ok := dst["remove"]; ok {
		t.Fatal("nil patch value should delete key")
	}
	if dst["keep"] != "yes" || dst["leaf"] != "new" {
		t.Fatalf("unexpected top-level merge: %#v", dst)
	}
	nested, ok := dst["nested"].(map[string]any)
	if !ok {
		t.Fatalf("nested missing: %#v", dst["nested"])
	}
	if _, ok := nested["b"]; ok {
		t.Fatal("nested nil should delete child")
	}
	if nested["a"] != 1.0 || nested["c"] != 3.0 {
		t.Fatalf("nested merge = %#v", nested)
	}
	fresh, ok := dst["fresh"].(map[string]any)
	if !ok || fresh["x"] != true {
		t.Fatalf("fresh nested map = %#v", dst["fresh"])
	}
}

func TestHelperScalarsAndNullables(t *testing.T) {
	if got := boundedString("  abc  ", 10); got != "abc" {
		t.Fatalf("boundedString trim = %q", got)
	}
	if got := boundedString("  "+strings.Repeat("x", 8), 5); got != strings.Repeat("x", 5) {
		t.Fatalf("boundedString truncate = %q", got)
	}
	if got := bounded("abcdef", 3); got != "abc" {
		t.Fatalf("bounded = %q", got)
	}
	if got := bounded("ab", 3); got != "ab" {
		t.Fatalf("bounded short = %q", got)
	}
	if nullable("") != nil {
		t.Fatal("nullable empty should be nil")
	}
	if got := nullable("id"); got == nil || *got != "id" {
		t.Fatalf("nullable = %v", got)
	}
	if valueString(nil) != "" {
		t.Fatal("valueString nil")
	}
	s := "hi"
	if valueString(&s) != "hi" {
		t.Fatal("valueString value")
	}
	if ptrString(nil) != "" {
		t.Fatal("ptrString nil")
	}
	if ptrString(&s) != "hi" {
		t.Fatal("ptrString value")
	}
	if nilText("") != nil {
		t.Fatal("nilText empty")
	}
	if got := nilText("x"); got != "x" {
		t.Fatalf("nilText = %v", got)
	}
	if nullString("  ") != nil {
		t.Fatal("nullString whitespace")
	}
	if nullString("") != nil {
		t.Fatal("nullString empty")
	}
	if got := nullString("proxy"); got != "proxy" {
		t.Fatalf("nullString = %v", got)
	}
	if blobOrNil(nil) != nil || blobOrNil([]byte{}) != nil {
		t.Fatal("blobOrNil empty")
	}
	blob := []byte{1, 2}
	if got := blobOrNil(blob); got == nil {
		t.Fatal("blobOrNil non-empty")
	}
}

func TestModelMappers(t *testing.T) {
	now := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)

	offense := offenseModel(offenseRow{
		IP: "1.2.3.4", Category: "auth", StrikeCount: 3, WindowStartedAt: now, LastEventAt: now,
	})
	if offense.IP != "1.2.3.4" || offense.StrikeCount != 3 || offense.Category != "auth" {
		t.Fatalf("offenseModel = %#v", offense)
	}

	rpm, daily := 10, 100
	quote := "q"
	api := apiKeyModel(apiKeyRow{
		ID: "k1", Name: "n", KeyPrefix: "pref", Active: true, RateLimitRpm: &rpm, DailyTokenLimit: &daily,
		OneTimeTokensUsed: 7, QuoteBigText: &quote, QuoteSubText: nil, DisableRemoteMapping: true, CreatedAt: now,
	})
	if api.ID != "k1" || api.QuoteBigText != "q" || api.QuoteSubText != "" || api.OneTimeTokensUsed != 7 || !api.DisableRemoteMapping {
		t.Fatalf("apiKeyModel = %#v", api)
	}

	exp := now.Add(time.Hour)
	share := shareModel(shareLinkRow{
		ID: "s1", APIKeyID: "k1", TokenHash: "th", Kind: "monitor", Active: true, CreatedAt: now, ExpiresAt: &exp,
	})
	if share.ID != "s1" || share.APIKeyID != "k1" || share.Kind != "monitor" || share.ExpiresAt == nil {
		t.Fatalf("shareModel = %#v", share)
	}

	user, pass, errText := "u", "p", "boom"
	proxy := proxyRow{
		ID: "p1", Name: "proxy", Protocol: "http", Host: "h", Port: 8080, Username: &user, Password: &pass,
		Priority: 1, Weight: 2, MaxConcurrency: 3, Active: true, CreatedAt: now, UpdatedAt: now, LastTestError: &errText,
	}.model()
	if proxy.Username != "u" || proxy.Password != "p" || proxy.LastTestError != "boom" || proxy.Protocol != "http" {
		t.Fatalf("proxyRow.model = %#v", proxy)
	}

	settings := settingsModel(proxySettingsRow{
		Enabled: true, Excluded: []byte(`[" OpenAI ", "openai", " Anthropic "]`), Smart: true, Count: 4,
		Preset: "balanced", Target: 8, WebSearch: "prefer", UpdatedAt: now,
	})
	if !settings.Enabled || !settings.SmartDynamicRouting || settings.SmartDynamicProxyCount != 4 || settings.RoutingPreset != "balanced" {
		t.Fatalf("settingsModel = %#v", settings)
	}
	if len(settings.ExcludedProviders) != 2 || settings.ExcludedProviders[0] != "anthropic" || settings.ExcludedProviders[1] != "openai" {
		t.Fatalf("excluded = %#v", settings.ExcludedProviders)
	}

	custom := "custom.endpoint"
	pid := 42
	warp := warpAccountRow{
		ID: "w1", Label: "lab", DeviceID: "d", AccessToken: "a", LicenseKey: "l", PrivateKey: "pk",
		AddressV4: "1.1.1.1", AddressV6: "::1", PublicKey: "pub", Endpoint: "ep", EndpointPort: 2408,
		DNS: "1.1.1.1", MTU: 1280, SocksPort: 1080, Enabled: true, Running: true, PID: &pid,
		PreferIPv6: true, CustomEndpoint: &custom, PersistentKeepalive: 25, CreatedAt: now,
	}.model()
	if warp.CustomEndpoint != "custom.endpoint" || warp.PID == nil || *warp.PID != 42 || !warp.PreferIPv6 {
		t.Fatalf("warpAccountRow.model = %#v", warp)
	}

	cp := customProviderRow{
		ID: "c1", Slug: "slug", Name: "Name", Type: "openai-compatible", Protocol: "openai", Surface: "openai-chat",
		BaseURL: "https://example.com", CredentialRef: "cred-1", CredentialRefs: []byte(`["cred-1","cred-2"]`),
		TimeoutSeconds: 15, ModelsJSON: []byte(`[{"id":"m"}]`), HeadersJSON: []byte(`{"X":"1"}`),
		CreatedAt: now, UpdatedAt: now,
	}.model()
	if cp.CredentialRef != "cred-1" || len(cp.CredentialRefs) != 2 || string(cp.Models) != `[{"id":"m"}]` {
		t.Fatalf("customProviderRow.model = %#v", cp)
	}
	fallback := customProviderRow{CredentialRef: "only", CredentialRefs: []byte("null")}.model()
	if len(fallback.CredentialRefs) != 1 || fallback.CredentialRefs[0] != "only" {
		t.Fatalf("credential fallback = %#v", fallback.CredentialRefs)
	}
}

func TestRequestHistoryHelpers(t *testing.T) {
	started := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	row, err := requestHistoryRowFromModel(models.RequestHistory{
		ID: 9, TraceID: " trace ", Endpoint: " chat ", Surface: " openai-chat ",
		APIKeyID: "k", Provider: "openai", Model: "m", Status: 200, Stream: true,
		StartedAt: started, FinishedAt: started.Add(time.Second), DurationMs: 1000,
		UsageSource: "provider", ClientName: "cli", ClientSource: "sdk", ClientIP: "9.9.9.9",
		MetaJSON: nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	if row.TraceID != "trace" || string(row.MetaJSON) != "{}" || row.APIKeyID == nil || *row.APIKeyID != "k" {
		t.Fatalf("success row = %#v", row)
	}
	mapped := row.model()
	if mapped.TraceID != "trace" || mapped.APIKeyID != "k" || mapped.ClientIP != "9.9.9.9" || string(mapped.MetaJSON) != "{}" {
		t.Fatalf("requestHistoryRow.model = %#v", mapped)
	}

	if _, err := requestHistoryRowFromModel(models.RequestHistory{Endpoint: "e", Surface: "s"}); err == nil {
		t.Fatal("missing required fields accepted")
	}
	if _, err := requestHistoryRowFromModel(models.RequestHistory{
		TraceID: "t", Endpoint: "e", Surface: "s", MetaJSON: make([]byte, maxTelemetryMeta+1),
	}); err == nil {
		t.Fatal("oversized metadata accepted")
	}

	payload := models.RequestPayload{
		ClientRequest: []byte("a"), ProviderRequest: []byte("bb"), ProviderResponse: []byte("ccc"),
		ClientResponse: []byte("dddd"), ClientRequestMeta: []byte("1"), ProviderRequestMeta: []byte("22"),
		ProviderResponseMeta: []byte("333"), ClientResponseMeta: []byte("4444"),
	}
	if got := payloadBytes(payload); got != 1+2+3+4+1+2+3+4 {
		t.Fatalf("payloadBytes = %d", got)
	}

	if telemetryLimit(0) != maxTelemetryLimit || telemetryLimit(-1) != maxTelemetryLimit || telemetryLimit(maxTelemetryLimit+1) != maxTelemetryLimit {
		t.Fatal("telemetryLimit clamp failed")
	}
	if telemetryLimit(12) != 12 {
		t.Fatal("telemetryLimit passthrough failed")
	}
}

func TestMetadataHelpers(t *testing.T) {
	cases := []struct {
		outcome telemetry.Outcome
		status  int
		kind    string
	}{
		{telemetry.OutcomeSuccess, 200, ""},
		{telemetry.OutcomeInvalidReq, 400, string(telemetry.OutcomeInvalidReq)},
		{telemetry.OutcomeAuthFailed, 401, string(telemetry.OutcomeAuthFailed)},
		{telemetry.OutcomeQuota, 429, string(telemetry.OutcomeQuota)},
		{telemetry.OutcomeCancelled, 499, string(telemetry.OutcomeCancelled)},
		{telemetry.OutcomeUpstreamFail, 502, string(telemetry.OutcomeUpstreamFail)},
		{telemetry.OutcomeError, 502, string(telemetry.OutcomeError)},
		{telemetry.OutcomeUnavailable, 502, string(telemetry.OutcomeUnavailable)},
		{telemetry.Outcome("weird"), 502, "weird"},
	}
	for _, tc := range cases {
		if got := metadataStatus(tc.outcome); got != tc.status {
			t.Fatalf("metadataStatus(%q)=%d want %d", tc.outcome, got, tc.status)
		}
		if got := metadataErrorKind(tc.outcome); got != tc.kind {
			t.Fatalf("metadataErrorKind(%q)=%q want %q", tc.outcome, got, tc.kind)
		}
	}

	if metadataToken(nil) != nil {
		t.Fatal("metadataToken nil")
	}
	neg := int64(-3)
	if got := metadataToken(&neg); got == nil || *got != 0 {
		t.Fatalf("metadataToken negative = %v", got)
	}
	zero := int64(0)
	if got := metadataToken(&zero); got == nil || *got != 0 {
		t.Fatalf("metadataToken zero = %v", got)
	}
	pos := int64(42)
	if got := metadataToken(&pos); got == nil || *got != 42 {
		t.Fatalf("metadataToken positive = %v", got)
	}
	if boundedInt64(99) != 99 {
		t.Fatal("boundedInt64 passthrough")
	}
	if boundedInt64(0) != 0 {
		t.Fatal("boundedInt64 zero")
	}
}

func TestTokenBudgetPureHelpers(t *testing.T) {
	limit := int64(100)
	if exceeds(nil, 0, 0, 1) {
		t.Fatal("nil limit should never exceed")
	}
	if !exceeds(&limit, 100, 0, 1) {
		t.Fatal("committed at limit should exceed")
	}
	if !exceeds(&limit, 40, 70, 1) {
		t.Fatal("reserved over remaining should exceed")
	}
	if !exceeds(&limit, 40, 50, 20) {
		t.Fatal("estimate over remaining should exceed")
	}
	if exceeds(&limit, 40, 50, 10) {
		t.Fatal("within budget reported as exceeded")
	}

	ts := time.Date(2026, 7, 15, 18, 30, 0, 0, time.FixedZone("PST", -8*3600))
	day := utcDay(ts)
	if day.Hour() != 0 || day.Location() != time.UTC || day.Day() != 16 {
		t.Fatalf("utcDay = %v", day)
	}
	month := utcMonth(ts)
	if month.Day() != 1 || month.Month() != time.July || month.Location() != time.UTC {
		t.Fatalf("utcMonth = %v", month)
	}
	a := time.Date(2026, 7, 16, 1, 0, 0, 0, time.UTC)
	b := time.Date(2026, 7, 15, 20, 0, 0, 0, time.FixedZone("PST", -8*3600))
	if !sameUTCDay(a, b) {
		t.Fatal("sameUTCDay should match converted day")
	}
	if sameUTCDay(a, a.Add(24*time.Hour)) {
		t.Fatal("sameUTCDay false positive")
	}

	in := int64(1)
	out := int64(2)
	row := tokenReservationRow{
		input: sql.NullInt64{Int64: 1, Valid: true}, output: sql.NullInt64{Int64: 2, Valid: true},
		cachedRead: sql.NullInt64{}, cachedWrite: sql.NullInt64{}, reasoning: sql.NullInt64{}, total: sql.NullInt64{},
	}
	if !sameUsage(row, usage.Tokens{Input: &in, Output: &out}) {
		t.Fatal("sameUsage matched values failed")
	}
	if sameUsage(row, usage.Tokens{Input: &in}) {
		t.Fatal("sameUsage mismatched nil output")
	}
	if !usageComplete(usage.Tokens{Total: &in}) {
		t.Fatal("usageComplete total")
	}
	if !usageComplete(usage.Tokens{Input: &in, Output: &out}) {
		t.Fatal("usageComplete input+output")
	}
	if usageComplete(usage.Tokens{Input: &in}) {
		t.Fatal("usageComplete incomplete")
	}
	if !sameNullable(sql.NullInt64{}, nil) {
		t.Fatal("sameNullable both absent")
	}
	if sameNullable(sql.NullInt64{Int64: 1, Valid: true}, nil) {
		t.Fatal("sameNullable stored vs nil")
	}
	if !sameNullable(sql.NullInt64{Int64: 5, Valid: true}, ptr(int64(5))) {
		t.Fatal("sameNullable equal")
	}
	if sameNullable(sql.NullInt64{Int64: 5, Valid: true}, ptr(int64(6))) {
		t.Fatal("sameNullable unequal")
	}

	if translateTokenBudgetError("op", nil) != nil {
		t.Fatal("translate nil")
	}
	for _, known := range []error{router.ErrInvalid, router.ErrLimit, router.ErrConflict, router.ErrUnavailable} {
		if got := translateTokenBudgetError("reserve", known); !errors.Is(got, known) {
			t.Fatalf("known %v became %v", known, got)
		}
	}
	if got := translateTokenBudgetError("reserve", context.Canceled); !errors.Is(got, context.Canceled) {
		t.Fatalf("canceled = %v", got)
	}
	if got := translateTokenBudgetError("reserve", context.DeadlineExceeded); !errors.Is(got, context.DeadlineExceeded) {
		t.Fatalf("deadline = %v", got)
	}
	got := translateTokenBudgetError("reserve", errors.New("disk"))
	if !errors.Is(got, router.ErrUnavailable) || !strings.Contains(got.Error(), "reserve persistence failed") {
		t.Fatalf("unknown wrap = %v", got)
	}
}

func TestAccountRowHelpers(t *testing.T) {
	cfg, err := (accountConfigRow{
		ID: "acc-1", ProviderID: "openai", Kind: string(accounts.KindOAuth), Enabled: true,
		Labels: []byte(`{"tier":"pro"}`), CredentialRef: []byte("cred-ref-1"),
		OAuthClientID: []byte("client"), RedirectURI: []byte("https://cb"), Scopes: []byte(`["a","b"]`),
	}).config()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ID != "acc-1" || cfg.ProviderID != "openai" || cfg.Kind != accounts.KindOAuth || !cfg.Enabled {
		t.Fatalf("config = %#v", cfg)
	}
	if cfg.Labels["tier"] != "pro" || cfg.CredentialRef.String() != "cred-ref-1" || cfg.OAuthClientID != "client" || len(cfg.Scopes) != 2 {
		t.Fatalf("config fields = %#v", cfg)
	}

	issued := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)
	rec := (tokenRecordRow{
		AccountID: "acc-1", ProviderID: "openai", Kind: string(accounts.KindOAuth), Origin: string(accounts.OriginOAuth),
		AccessFingerprint: "af", RefreshFingerprint: "rf", Scope: "s", ProviderAccountID: "pa",
		Email: "e@x", OrgID: "o", OrgName: "org", ExpiresAt: issued.Add(time.Hour), IssuedAt: issued,
		ReauthenticationRequired: true, Version: 9,
	}).record()
	if rec.AccountID != "acc-1" || rec.AccessFingerprint != "af" || rec.Version != 9 || !rec.ReauthenticationRequired {
		t.Fatalf("record = %#v", rec)
	}

	dir := accountDirectoryRow{
		ConfigID: "acc-1", ConfigProviderID: "openai", ConfigKind: string(accounts.KindAPIKey), ConfigEnabled: true,
		ConfigLabelsJSON: []byte(`{}`), ConfigCredentialRef: []byte("cred-ref-2"), ConfigOAuthClientID: []byte(""),
		ConfigRedirectURI: []byte(""), ConfigScopesJSON: []byte(`[]`),
		RecordAccountID: "acc-1", RecordProviderID: "openai", RecordKind: string(accounts.KindAPIKey),
		RecordOrigin: string(accounts.OriginExternal), RecordAccessFingerprint: "af2", RecordVersion: 3,
		RecordIssuedAt: issued, RecordExpiresAt: issued.Add(time.Minute),
	}
	cfg2, err := dir.config()
	if err != nil {
		t.Fatal(err)
	}
	if cfg2.CredentialRef.String() != "cred-ref-2" || cfg2.Kind != accounts.KindAPIKey {
		t.Fatalf("directory config = %#v", cfg2)
	}
	rec2 := dir.record()
	if rec2.AccessFingerprint != "af2" || rec2.Version != 3 {
		t.Fatalf("directory record = %#v", rec2)
	}
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	db, _ := newFakeBun(t)
	stores, err := NewBunAccountStores(db, []byte("test-encryption-key!!"))
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte("super-secret-material")
	enc, err := stores.encrypt(plain)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(enc, plain) {
		t.Fatal("ciphertext equals plaintext")
	}
	got, err := stores.decrypt(enc)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("decrypt = %q want %q", got, plain)
	}

	_, err = stores.decrypt([]byte{1, 2, 3})
	if err == nil || !strings.Contains(err.Error(), "truncated") {
		t.Fatalf("truncated decrypt err = %v", err)
	}
}

func TestRefreshLeaseHandlePurePaths(t *testing.T) {
	var nilHandle *refreshLeaseHandle
	if fence := nilHandle.Fence(); fence != (accounts.RefreshFence{}) {
		t.Fatalf("nil Fence = %#v", fence)
	}
	if err := nilHandle.Renew(context.Background(), time.Second); err != nil {
		t.Fatalf("nil Renew = %v", err)
	}
	if err := nilHandle.Release(context.Background()); err != nil {
		t.Fatalf("nil Release = %v", err)
	}

	h := &refreshLeaseHandle{ownerID: "owner", generation: 7, once: make(chan struct{}, 1)}
	fence := h.Fence()
	if fence.OwnerID != "owner" || fence.Generation != 7 {
		t.Fatalf("Fence = %#v", fence)
	}
	if err := h.Renew(context.Background(), time.Second); err != nil {
		t.Fatalf("nil-store Renew = %v", err)
	}
	if err := h.Release(context.Background()); err != nil {
		t.Fatalf("nil-store Release = %v", err)
	}

	filled := &refreshLeaseHandle{
		store: &BunRefreshLeaseStore{},
		once:  make(chan struct{}, 1),
	}
	filled.once <- struct{}{}
	if err := filled.Release(context.Background()); err != nil {
		t.Fatalf("already-released once path = %v", err)
	}
}

func TestCustomProviderValuesBranches(t *testing.T) {
	base := models.CustomProvider{
		ID: " id ", Slug: " slug ", Name: " Name ", BaseURL: " https://api.example.com/ ",
		Type: "openai-compatible", CredentialRef: " cred-a ",
	}
	got, err := customProviderValues(base)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "id" || got.Slug != "slug" || got.BaseURL != "https://api.example.com" {
		t.Fatalf("trim = %#v", got)
	}
	if got.Protocol != "openai" || got.Surface != "openai-chat" || got.TimeoutSeconds != 30 {
		t.Fatalf("openai defaults = %#v", got)
	}
	if string(got.Models) != "[]" || string(got.CustomHeaders) != "{}" || got.CreatedAt.IsZero() || got.UpdatedAt.IsZero() {
		t.Fatalf("payload defaults = %#v", got)
	}

	anth, err := customProviderValues(models.CustomProvider{
		ID: "a", Slug: "a", Name: "A", BaseURL: "https://a", Type: "anthropic-compatible", CredentialRef: "c",
	})
	if err != nil {
		t.Fatal(err)
	}
	if anth.Protocol != "anthropic" || anth.Surface != "anthropic-messages" {
		t.Fatalf("anthropic defaults = %#v", anth)
	}

	legacyOpenAI, err := customProviderValues(models.CustomProvider{
		ID: "o", Slug: "o", Name: "O", BaseURL: "https://o", Type: "openai", CredentialRef: "c",
	})
	if err != nil || legacyOpenAI.Protocol != "openai" {
		t.Fatalf("openai type = %#v err=%v", legacyOpenAI, err)
	}
	legacyAnth, err := customProviderValues(models.CustomProvider{
		ID: "n", Slug: "n", Name: "N", BaseURL: "https://n", Type: "anthropic", CredentialRef: "c",
	})
	if err != nil || legacyAnth.Protocol != "anthropic" {
		t.Fatalf("anthropic type = %#v err=%v", legacyAnth, err)
	}

	resp, err := customProviderValues(models.CustomProvider{
		ID: "r", Slug: "r", Name: "R", BaseURL: "https://r", Type: "openai-compatible",
		Protocol: "openai", Surface: "openai-responses",
		CredentialRefs: []string{"cred-b", "", "cred-b"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.CredentialRef != "cred-b" || len(resp.CredentialRefs) != 1 || resp.Surface != "openai-responses" {
		t.Fatalf("refs/surface = %#v", resp)
	}
	dedup, err := customProviderValues(models.CustomProvider{
		ID: "d", Slug: "d", Name: "D", BaseURL: "https://d", Type: "openai-compatible",
		CredentialRef: "cred-a", CredentialRefs: []string{"", "cred-b", "cred-a", "cred-b"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if dedup.CredentialRef != "cred-a" || len(dedup.CredentialRefs) != 2 || dedup.CredentialRefs[0] != "cred-a" || dedup.CredentialRefs[1] != "cred-b" {
		t.Fatalf("credential dedupe = %#v", dedup.CredentialRefs)
	}

	if _, err := customProviderValues(models.CustomProvider{Slug: "s", Name: "n", BaseURL: "https://x", Type: "openai"}); err == nil {
		t.Fatal("missing id accepted")
	}
	if _, err := customProviderValues(models.CustomProvider{ID: "i", Slug: "s", Name: "n", BaseURL: "https://x", Type: "weird", CredentialRef: "c"}); err == nil {
		t.Fatal("bad type accepted")
	}
	if _, err := customProviderValues(models.CustomProvider{
		ID: "i", Slug: "s", Name: "n", BaseURL: "https://x", Type: "openai-compatible",
		Protocol: "openai", Surface: "anthropic-messages", CredentialRef: "c",
	}); err == nil {
		t.Fatal("bad protocol/surface accepted")
	}
	if _, err := customProviderValues(models.CustomProvider{
		ID: "i", Slug: "s", Name: "n", BaseURL: "https://x", Type: "anthropic-compatible",
		Protocol: "anthropic", Surface: "openai-chat", CredentialRef: "c",
	}); err == nil {
		t.Fatal("anthropic/openai-chat accepted")
	}
	if _, err := customProviderValues(models.CustomProvider{
		ID: "i", Slug: "s", Name: "n", BaseURL: "https://x", Type: "openai-compatible",
	}); err == nil {
		t.Fatal("missing credential accepted")
	}
}
