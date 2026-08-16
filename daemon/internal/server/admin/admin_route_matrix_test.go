package admin

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

const matrixSecretMarker = "sk-live-admin-matrix-secret"

type matrixAuthorizer struct{}

func (matrixAuthorizer) Authorize(_ context.Context, sessionID string, _ AdminScope) (AdminActor, error) {
	if strings.TrimSpace(sessionID) == "" {
		return AdminActor{}, NewError(CodeAdminAuthentication, "authentication required")
	}
	return AdminActor{ID: "operator-matrix"}, nil
}

type matrixAuthService struct {
	scopes []string
}

func (a matrixAuthService) Login(_ context.Context, _ LoginInput, req AuthRequest) (LoginResult, error) {
	_ = req
	return LoginResult{
		Session:   Session{ID: "session-1", User: "operator", Scopes: []string{"admin:*"}},
		SetCookie: "cartethyia_session=session-1; Path=/; HttpOnly",
		MaxAge:    3600,
	}, nil
}
func (a matrixAuthService) Logout(context.Context, string) error { return nil }
func (a matrixAuthService) Current(_ context.Context, sessionID string) (Session, error) {
	if sessionID == "" {
		return Session{}, NewError(CodeAdminAuthentication, "authentication required")
	}
	scopes := a.scopes
	if len(scopes) == 0 {
		scopes = []string{"admin:*"}
	}
	return Session{ID: sessionID, User: "operator", Scopes: scopes}, nil
}
func (a matrixAuthService) Refresh(_ context.Context, sessionID string) (Session, error) {
	return a.Current(context.Background(), sessionID)
}
func (a matrixAuthService) OAuthStart(context.Context, string, OAuthStartInput) (OAuthState, error) {
	return OAuthState{SessionID: "oauth-session", Status: "pending", URL: "https://example.test/authorize", Flow: "browser"}, nil
}
func (a matrixAuthService) OAuthComplete(context.Context, string, OAuthCompleteInput) (OAuthState, error) {
	return OAuthState{SessionID: "oauth-session", Status: "completed", AccountID: "acct-1"}, nil
}
func (a matrixAuthService) OAuthCancel(context.Context, string) error { return nil }
func (a matrixAuthService) OAuthRefresh(_ context.Context, input OAuthRefreshInput) (OAuthState, error) {
	return OAuthState{AccountID: input.AccountID, Status: "refreshed"}, nil
}
func (a matrixAuthService) OAuthStatus(context.Context, string) (OAuthState, error) {
	return OAuthState{SessionID: "oauth-session", Status: "pending", UserCode: "ABCD", VerificationURI: "https://example.test/device"}, nil
}
func (a matrixAuthService) OAuthReauthenticate(_ context.Context, input OAuthRefreshInput) (OAuthState, error) {
	return OAuthState{AccountID: input.AccountID, Status: "reauthentication-required"}, nil
}

type matrixAccounts struct{}

func (matrixAccounts) List(context.Context, string) ([]contracts.Account, error) {
	return []contracts.Account{{ID: "acct-1", Provider: "openai", Enabled: true}}, nil
}
func (matrixAccounts) BatchCreate(_ context.Context, _ string, items []AccountInput) ([]contracts.Account, error) {
	out := make([]contracts.Account, 0, len(items))
	for i := range items {
		out = append(out, contracts.Account{ID: "batch-" + items[i].Label, Provider: "openai", Enabled: true})
	}
	return out, nil
}
func (matrixAccounts) Create(_ context.Context, providerID string, input AccountInput) (contracts.Account, error) {
	return contracts.Account{ID: "acct-new", Provider: providerID, Name: input.Name, Enabled: true}, nil
}
func (matrixAccounts) Update(_ context.Context, providerID, accountID string, input AccountInput) (contracts.Account, error) {
	return contracts.Account{ID: accountID, Provider: providerID, Name: input.Name, Enabled: true}, nil
}
func (matrixAccounts) Delete(context.Context, string, string) error { return nil }
func (matrixAccounts) BatchDelete(context.Context, string, []string) (BatchResult, error) {
	return BatchResult{Processed: 1, Succeeded: 1}, nil
}
func (matrixAccounts) BatchUpdate(context.Context, string, []AccountBatchPatch) (BatchResult, error) {
	return BatchResult{Processed: 1, Succeeded: 1}, nil
}
func (matrixAccounts) Credential(context.Context, string) (string, error) {
	return "", NewError(CodeUnavailable, "credential material is not exposed")
}
func (matrixAccounts) RefreshQuota(_ context.Context, accountID string) (QuotaState, error) {
	return QuotaState{AccountID: accountID, Used: 1, Limit: 10, Remaining: 9}, nil
}
func (matrixAccounts) RefreshAllQuotas(context.Context, QuotaRefreshRequest) (BatchResult, error) {
	return BatchResult{Processed: 1, Succeeded: 1}, nil
}
func (matrixAccounts) Quota(_ context.Context, accountID string) (QuotaState, error) {
	return QuotaState{AccountID: accountID, Used: 1, Limit: 10, Remaining: 9}, nil
}
func (matrixAccounts) Revoke(context.Context, string) error                    { return nil }
func (matrixAccounts) RevokeForProvider(context.Context, string, string) error { return nil }
func (matrixAccounts) OAuthStatus(_ context.Context, accountID string) (OAuthState, error) {
	return OAuthState{AccountID: accountID, Status: "ready"}, nil
}

type matrixAPIKeys struct{}

func (matrixAPIKeys) List(context.Context) ([]APIKey, error) {
	return []APIKey{{ID: "key-1", Name: "primary"}}, nil
}
func (matrixAPIKeys) Create(_ context.Context, input APIKeyInput) (APIKeyCreateResult, error) {
	return APIKeyCreateResult{Record: APIKey{ID: "key-new", Name: input.Name}, Key: matrixSecretMarker}, nil
}
func (matrixAPIKeys) Update(_ context.Context, id string, input APIKeyInput) (APIKey, error) {
	return APIKey{ID: id, Name: input.Name}, nil
}
func (matrixAPIKeys) Regenerate(_ context.Context, id string) (APIKeyCreateResult, error) {
	return APIKeyCreateResult{Record: APIKey{ID: id, Name: "rotated"}, Key: matrixSecretMarker}, nil
}
func (matrixAPIKeys) Revoke(context.Context, string) error { return nil }
func (matrixAPIKeys) Delete(context.Context, string) error { return nil }
func (matrixAPIKeys) Credential(context.Context, string) (string, error) {
	return matrixSecretMarker, nil
}
func (matrixAPIKeys) ShareLink(_ context.Context, id, kind, baseURL string) (ShareLink, error) {
	return ShareLink{URL: baseURL + "/share/" + id, Kind: kind, ExpiresAt: "2099-01-01T00:00:00Z"}, nil
}
func (matrixAPIKeys) RevokeShareLinks(context.Context, string) (int, error) { return 2, nil }

type matrixProxies struct{}

func (matrixProxies) List(context.Context, int) ([]Proxy, error) {
	return []Proxy{{ID: "proxy-1", Protocol: "http", Host: "127.0.0.1", Port: 8080, Enabled: true}}, nil
}
func (matrixProxies) Create(_ context.Context, input ProxyInput) (Proxy, error) {
	return Proxy{ID: "proxy-new", Protocol: input.Protocol, Host: input.Host, Port: input.Port, Enabled: true}, nil
}
func (matrixProxies) Update(_ context.Context, id string, input ProxyInput) (Proxy, error) {
	return Proxy{ID: id, Protocol: input.Protocol, Host: input.Host, Port: input.Port, Enabled: true}, nil
}
func (matrixProxies) Delete(context.Context, string) error { return nil }
func (matrixProxies) Credential(context.Context, string) (string, error) {
	return matrixSecretMarker, nil
}
func (matrixProxies) Test(_ context.Context, id string) (ProxyTestResult, error) {
	return ProxyTestResult{ProxyID: id, Reachable: true, LatencyMS: 5}, nil
}
func (matrixProxies) TestAdHoc(context.Context, ProxyInput) (ProxyTestResult, error) {
	return ProxyTestResult{Reachable: true, LatencyMS: 3}, nil
}
func (matrixProxies) Search(context.Context, ProxySearchInput) ([]Proxy, error) {
	return []Proxy{{ID: "found", Protocol: "socks5", Host: "10.0.0.1", Port: 1080}}, nil
}
func (matrixProxies) Import(context.Context, ProxyImportInput) (BatchResult, error) {
	return BatchResult{Processed: 1, Succeeded: 1}, nil
}
func (matrixProxies) Scrape(context.Context, ProxyScrapeInput) (BatchResult, error) {
	return BatchResult{Processed: 1, Succeeded: 1}, nil
}
func (matrixProxies) Settings(context.Context) (ProxySettings, error) {
	return ProxySettings{Mode: "auto"}, nil
}
func (matrixProxies) PatchSettings(_ context.Context, input ProxySettingsInput) (ProxySettings, error) {
	mode := "auto"
	if input.Mode != nil {
		mode = *input.Mode
	}
	return ProxySettings{Mode: mode}, nil
}
func (matrixProxies) Countries(context.Context) ([]string, error) { return []string{"US", "DE"}, nil }
func (matrixProxies) ScrapeCatalog(context.Context) []ScrapeSourceInfo {
	return []ScrapeSourceInfo{{ID: "src-1", Label: "Fixture", CountryAware: true}}
}

type matrixBackup struct{}

func (matrixBackup) List(context.Context) ([]BackupRecord, error) {
	return []BackupRecord{{ID: "bkp-1", CreatedAt: "2026-01-01T00:00:00Z", SizeBytes: 12}}, nil
}
func (matrixBackup) Create(_ context.Context, input BackupCreateInput) (BackupRecord, error) {
	return BackupRecord{ID: "bkp-new", Note: input.Note, IncludesDB: input.IncludesDB}, nil
}
func (matrixBackup) Download(_ context.Context, id string) (BackupArtifact, error) {
	return BackupArtifact{
		Record:   BackupRecord{ID: id},
		Content:  []byte("backup-bytes"),
		Filename: id + ".bin",
		MIMEType: "application/octet-stream",
	}, nil
}
func (matrixBackup) Restore(context.Context, string, RestoreOptions) (RestoreResult, error) {
	return RestoreResult{Applied: true, Changed: []string{"settings"}}, nil
}
func (matrixBackup) Delete(context.Context, string) error { return nil }

type matrixCustomProviders struct{}

func (matrixCustomProviders) List(context.Context) ([]CustomProvider, error) {
	return []CustomProvider{{ID: "cp-1", Slug: "custom", Name: "Custom", CredentialRef: "ref-1"}}, nil
}
func (matrixCustomProviders) Get(_ context.Context, id string) (CustomProvider, error) {
	return CustomProvider{ID: id, Slug: "custom", Name: "Custom", CredentialRef: "ref-1"}, nil
}
func (matrixCustomProviders) Upsert(_ context.Context, input CustomProviderInput) (CustomProvider, error) {
	return CustomProvider{ID: input.ID, Slug: slugOr(input.Slug, "custom"), Name: input.Name, CredentialRef: input.CredentialRef}, nil
}
func (matrixCustomProviders) Delete(context.Context, string) error { return nil }

func slugOr(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

type matrixFailingCustomProviders struct{}

func (matrixFailingCustomProviders) List(context.Context) ([]CustomProvider, error) {
	return nil, errors.New("authorization Bearer " + matrixSecretMarker)
}
func (matrixFailingCustomProviders) Get(context.Context, string) (CustomProvider, error) {
	return CustomProvider{}, NewError(CodeNotFound, "missing")
}
func (matrixFailingCustomProviders) Upsert(context.Context, CustomProviderInput) (CustomProvider, error) {
	return CustomProvider{}, errors.New("password=" + matrixSecretMarker)
}
func (matrixFailingCustomProviders) Delete(context.Context, string) error {
	return NewError(CodeUnavailable, "delete failed")
}

func matrixServices() Services {
	return Services{
		Dashboard:       testDashboard{},
		Accounts:        matrixAccounts{},
		APIKeys:         matrixAPIKeys{},
		Proxies:         matrixProxies{},
		Settings:        testSettings{},
		Backup:          matrixBackup{},
		Tools:           testTools{},
		Auth:            matrixAuthService{},
		Telemetry:       &routeTelemetry{},
		ConsoleLogs:     routeConsoleLogs{},
		Usage:           routeUsage{},
		WebRequest:      routeWebRequest{},
		Catalog:         catalogTestService{},
		CustomProviders: matrixCustomProviders{},
		Authorizer:      matrixAuthorizer{},
		Audit:           &testAudit{},
		Generation:      &testGeneration{},
	}
}

func assertNoSecrets(t *testing.T, body string) {
	t.Helper()
	lower := strings.ToLower(body)
	for _, marker := range []string{
		matrixSecretMarker,
		"authorization bearer " + strings.ToLower(matrixSecretMarker),
		"password=" + strings.ToLower(matrixSecretMarker),
	} {
		if strings.Contains(lower, strings.ToLower(marker)) {
			t.Fatalf("response leaked secret material %q: %s", marker, body)
		}
	}
}

func withSession(req *http.Request) *http.Request {
	req.Header.Set("X-Session-Id", "session-matrix")
	return req
}

func TestAdminRouteMatrixAuthenticatedSuccessAndAuthFailure(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, matrixServices())

	type caseSpec struct {
		group  string
		method string
		path   string
		body   string
		want   int
	}

	success := []caseSpec{
		{group: "auth", method: http.MethodPost, path: "/v2/admin/auth/login", body: `{"username":"op","password":"x"}`, want: http.StatusOK},
		{group: "auth", method: http.MethodGet, path: "/v2/admin/auth/session", want: http.StatusOK},
		{group: "accounts", method: http.MethodGet, path: "/v2/admin/accounts", want: http.StatusOK},
		{group: "accounts", method: http.MethodGet, path: "/v2/admin/providers/openai/accounts", want: http.StatusOK},
		{group: "keys", method: http.MethodGet, path: "/v2/admin/keys", want: http.StatusOK},
		{group: "catalog", method: http.MethodGet, path: "/v2/admin/catalog/providers", want: http.StatusOK},
		{group: "custom-providers", method: http.MethodGet, path: "/v2/admin/custom-providers", want: http.StatusOK},
		{group: "proxies", method: http.MethodGet, path: "/v2/admin/proxies", want: http.StatusOK},
		{group: "proxy-settings", method: http.MethodGet, path: "/v2/admin/proxy-settings", want: http.StatusOK},
		{group: "web-search-routing", method: http.MethodGet, path: "/v2/admin/web-search-routing", want: http.StatusOK},
		{group: "settings", method: http.MethodGet, path: "/v2/admin/settings", want: http.StatusOK},
		{group: "backups", method: http.MethodGet, path: "/v2/admin/backups", want: http.StatusOK},
		{group: "telemetry", method: http.MethodGet, path: "/v2/admin/telemetry/overview", want: http.StatusOK},
		{group: "console", method: http.MethodGet, path: "/v2/admin/console/logs", want: http.StatusOK},
		{group: "console", method: http.MethodPost, path: "/v2/admin/console/web-request", body: `{"url":"https://example.test/"}`, want: http.StatusOK},
		{group: "tools", method: http.MethodPost, path: "/v2/admin/tools/reindex", body: `{"target":"catalog"}`, want: http.StatusOK},
		{group: "dashboard", method: http.MethodGet, path: "/v2/admin/dashboard", want: http.StatusOK},
	}

	for _, tc := range success {
		t.Run("success/"+tc.group+"/"+tc.method+tc.path, func(t *testing.T) {
			var bodyReader *strings.Reader
			if tc.body != "" {
				bodyReader = strings.NewReader(tc.body)
			} else {
				bodyReader = strings.NewReader("")
			}
			req := httptest.NewRequest(tc.method, tc.path, bodyReader)
			if tc.path != "/v2/admin/auth/login" {
				withSession(req)
			}
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			req.Header.Set("X-Forwarded-For", "203.0.113.10, 10.0.0.1")
			req.Header.Set("X-Forwarded-Proto", "https")
			req.Header.Set("User-Agent", "matrix-test")
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertNoSecrets(t, rec.Body.String())
		})
	}

	failures := []caseSpec{
		{group: "auth", method: http.MethodGet, path: "/v2/admin/auth/session", want: http.StatusUnauthorized},
		{group: "accounts", method: http.MethodGet, path: "/v2/admin/accounts", want: http.StatusUnauthorized},
		{group: "accounts", method: http.MethodGet, path: "/v2/admin/providers/openai/accounts", want: http.StatusUnauthorized},
		{group: "keys", method: http.MethodGet, path: "/v2/admin/keys", want: http.StatusUnauthorized},
		{group: "catalog", method: http.MethodGet, path: "/v2/admin/catalog/providers", want: http.StatusUnauthorized},
		{group: "custom-providers", method: http.MethodGet, path: "/v2/admin/custom-providers", want: http.StatusUnauthorized},
		{group: "proxies", method: http.MethodGet, path: "/v2/admin/proxies", want: http.StatusUnauthorized},
		{group: "proxy-settings", method: http.MethodGet, path: "/v2/admin/proxy-settings", want: http.StatusUnauthorized},
		{group: "web-search-routing", method: http.MethodGet, path: "/v2/admin/web-search-routing", want: http.StatusUnauthorized},
		{group: "settings", method: http.MethodGet, path: "/v2/admin/settings", want: http.StatusUnauthorized},
		{group: "backups", method: http.MethodGet, path: "/v2/admin/backups", want: http.StatusUnauthorized},
		{group: "telemetry", method: http.MethodGet, path: "/v2/admin/telemetry/overview", want: http.StatusUnauthorized},
		{group: "console", method: http.MethodGet, path: "/v2/admin/console/logs", want: http.StatusUnauthorized},
		{group: "console", method: http.MethodPost, path: "/v2/admin/console/web-request", body: `{"url":"https://example.test/"}`, want: http.StatusUnauthorized},
		{group: "tools", method: http.MethodPost, path: "/v2/admin/tools/reindex", body: `{"target":"catalog"}`, want: http.StatusUnauthorized},
		{group: "dashboard", method: http.MethodGet, path: "/v2/admin/dashboard", want: http.StatusUnauthorized},
	}

	for _, tc := range failures {
		t.Run("auth_failure/"+tc.group+"/"+tc.path, func(t *testing.T) {
			body := strings.NewReader(tc.body)
			req := httptest.NewRequest(tc.method, tc.path, body)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertNoSecrets(t, rec.Body.String())
		})
	}
}

func TestAdminRouteMatrixValidationFailures(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, matrixServices())

	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{name: "settings_log_level", method: http.MethodPatch, path: "/v2/admin/settings", body: `{"logLevel":"verbose"}`},
		{name: "keys_name_too_long", method: http.MethodPost, path: "/v2/admin/keys", body: `{"name":"` + strings.Repeat("n", 300) + `"}`},
		{name: "proxy_host_missing", method: http.MethodPost, path: "/v2/admin/proxies", body: `{"protocol":"http","host":"","port":8080}`},
		{name: "account_label_too_long", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts", body: `{"label":"` + strings.Repeat("a", 300) + `"}`},
		{name: "backup_note_too_long", method: http.MethodPost, path: "/v2/admin/backups", body: `{"note":"` + strings.Repeat("b", 300) + `"}`},
		{name: "probe_url_invalid", method: http.MethodPost, path: "/v2/admin/tools/probe", body: `{"url":"not-a-url"}`},
		{name: "oauth_refresh_missing_account", method: http.MethodPost, path: "/v2/admin/auth/oauth/refresh", body: `{"accountId":""}`},
		{name: "web_request_missing_url", method: http.MethodPost, path: "/v2/admin/console/web-request", body: `{"url":""}`},
		{name: "metadata_secret_field", method: http.MethodPost, path: "/v2/admin/keys", body: `{"name":"ok","metadata":{"api_token":"x"}}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := withSession(httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertNoSecrets(t, rec.Body.String())
		})
	}
}

func TestAdminRouteMatrixUnavailableDependencies(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, Services{
		Dashboard:  testDashboard{},
		Authorizer: matrixAuthorizer{},
		// Catalog and custom providers stay registered and return unavailable.
	})

	cases := []struct {
		path string
	}{
		{"/v2/admin/catalog/providers"},
		{"/v2/admin/catalog/models"},
		{"/v2/admin/custom-providers"},
		{"/v2/admin/custom-providers/cp-1"},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			req := withSession(httptest.NewRequest(http.MethodGet, tc.path, nil))
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertNoSecrets(t, rec.Body.String())
		})
	}
}

func TestAdminRouteMatrixSubresourceCoverage(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, matrixServices())

	cases := []struct {
		name   string
		method string
		path   string
		body   string
		want   int
	}{
		{name: "auth_logout", method: http.MethodPost, path: "/v2/admin/auth/logout", want: http.StatusOK},
		{name: "auth_refresh", method: http.MethodPost, path: "/v2/admin/auth/refresh", want: http.StatusOK},
		{name: "oauth_start", method: http.MethodPost, path: "/v2/admin/auth/oauth/start?providerId=openai", body: `{"flow":"browser"}`, want: http.StatusOK},
		{name: "oauth_status", method: http.MethodGet, path: "/v2/admin/auth/oauth/sessions/oauth-session/status", want: http.StatusOK},
		{name: "oauth_complete", method: http.MethodPost, path: "/v2/admin/auth/oauth/sessions/oauth-session/complete", body: `{"code":"abc","state":"st"}`, want: http.StatusOK},
		{name: "oauth_cancel", method: http.MethodPost, path: "/v2/admin/auth/oauth/sessions/oauth-session/cancel", want: http.StatusOK},
		{name: "oauth_refresh", method: http.MethodPost, path: "/v2/admin/auth/oauth/refresh", body: `{"accountId":"acct-1","force":true}`, want: http.StatusOK},
		{name: "oauth_reauth", method: http.MethodPost, path: "/v2/admin/auth/oauth/reauth", body: `{"accountId":"acct-1"}`, want: http.StatusOK},
		{name: "account_patch", method: http.MethodPatch, path: "/v2/admin/accounts/acct-1", body: `{"name":"renamed"}`, want: http.StatusOK},
		{name: "account_delete", method: http.MethodDelete, path: "/v2/admin/accounts/acct-2", want: http.StatusNoContent},
		{name: "account_quota_get", method: http.MethodGet, path: "/v2/admin/accounts/acct-1/quota", want: http.StatusOK},
		{name: "account_quota_refresh", method: http.MethodPost, path: "/v2/admin/accounts/acct-1/quota", want: http.StatusOK},
		{name: "account_revoke", method: http.MethodPost, path: "/v2/admin/accounts/acct-1/revoke", want: http.StatusOK},
		{name: "account_oauth_status", method: http.MethodGet, path: "/v2/admin/accounts/acct-1/oauth-status", want: http.StatusOK},
		{name: "quota_refresh_all", method: http.MethodPost, path: "/v2/admin/quota/refresh", body: `{"providerId":"openai"}`, want: http.StatusOK},
		{name: "provider_create", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts", body: `{"name":"n1","label":"l1"}`, want: http.StatusCreated},
		{name: "provider_batch_create", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/batch", body: `{"items":[{"label":"a"}]}`, want: http.StatusCreated},
		{name: "provider_batch_update", method: http.MethodPatch, path: "/v2/admin/providers/openai/accounts/batch", body: `{"items":[{"accountId":"acct-1"}]}`, want: http.StatusOK},
		{name: "provider_batch_delete", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/batch-delete", body: `{"items":["acct-1"]}`, want: http.StatusOK},
		{name: "provider_update", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/acct-1", body: `{"name":"n2"}`, want: http.StatusOK},
		{name: "provider_delete", method: http.MethodDelete, path: "/v2/admin/providers/openai/accounts/acct-9", want: http.StatusNoContent},
		{name: "provider_revoke", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/acct-1/revoke", want: http.StatusOK},
		{name: "provider_oauth_start_redirect", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/oauth/start", want: http.StatusNotFound},
		{name: "keys_create", method: http.MethodPost, path: "/v2/admin/keys", body: `{"name":"created"}`, want: http.StatusCreated},
		{name: "keys_patch", method: http.MethodPatch, path: "/v2/admin/keys/key-1", body: `{"name":"patched"}`, want: http.StatusOK},
		{name: "keys_delete", method: http.MethodDelete, path: "/v2/admin/keys/key-2", want: http.StatusNoContent},
		{name: "keys_regenerate", method: http.MethodPost, path: "/v2/admin/keys/key-1/regenerate", want: http.StatusOK},
		{name: "keys_revoke", method: http.MethodPost, path: "/v2/admin/keys/key-1/revoke", want: http.StatusOK},
		{name: "keys_share", method: http.MethodPost, path: "/v2/admin/keys/key-1/share", want: http.StatusOK},
		{name: "keys_setup_link", method: http.MethodPost, path: "/v2/admin/keys/key-1/setup-link", want: http.StatusOK},
		{name: "keys_revoke_share", method: http.MethodDelete, path: "/v2/admin/keys/key-1/revoke-share", want: http.StatusOK},
		{name: "proxy_create", method: http.MethodPost, path: "/v2/admin/proxies", body: `{"protocol":"http","host":"127.0.0.1","port":8080}`, want: http.StatusCreated},
		{name: "proxy_patch", method: http.MethodPatch, path: "/v2/admin/proxies/proxy-1", body: `{"protocol":"http","host":"127.0.0.1","port":8081}`, want: http.StatusOK},
		{name: "proxy_delete", method: http.MethodDelete, path: "/v2/admin/proxies/proxy-2", want: http.StatusNoContent},
		{name: "proxy_test", method: http.MethodPost, path: "/v2/admin/proxies/proxy-1/test", want: http.StatusOK},
		{name: "proxy_countries", method: http.MethodGet, path: "/v2/admin/proxies/scrape/countries", want: http.StatusOK},
		{name: "proxy_catalog", method: http.MethodGet, path: "/v2/admin/proxies/scrape/catalog", want: http.StatusOK},
		{name: "proxy_search", method: http.MethodPost, path: "/v2/admin/proxies/search", body: `{"query":"us","limit":5}`, want: http.StatusOK},
		{name: "proxy_import", method: http.MethodPost, path: "/v2/admin/proxies/import", body: `{"proxies":[{"protocol":"http","host":"1.1.1.1","port":80}]}`, want: http.StatusOK},
		{name: "proxy_scrape", method: http.MethodPost, path: "/v2/admin/proxies/scrape", body: `{"limit":1}`, want: http.StatusOK},
		{name: "proxy_settings_patch", method: http.MethodPost, path: "/v2/admin/proxy-settings", body: `{"mode":"manual"}`, want: http.StatusOK},
		{name: "settings_reset_post", method: http.MethodPost, path: "/v2/admin/settings", want: http.StatusOK},
		{name: "settings_reset_delete", method: http.MethodDelete, path: "/v2/admin/settings", want: http.StatusOK},
		{name: "backup_create", method: http.MethodPost, path: "/v2/admin/backups", body: `{"note":"nightly","includesDatabase":true}`, want: http.StatusCreated},
		{name: "backup_download", method: http.MethodGet, path: "/v2/admin/backups/bkp-1/download", want: http.StatusOK},
		{name: "backup_restore", method: http.MethodPost, path: "/v2/admin/backups/bkp-1/restore", body: `{"dryRun":true}`, want: http.StatusOK},
		{name: "backup_delete", method: http.MethodDelete, path: "/v2/admin/backups/bkp-1", want: http.StatusNoContent},
		{name: "tools_cache", method: http.MethodPost, path: "/v2/admin/tools/cache/models", want: http.StatusOK},
		{name: "tools_probe", method: http.MethodPost, path: "/v2/admin/tools/probe", body: `{"url":"https://example.test/health"}`, want: http.StatusOK},
		{name: "tools_restart", method: http.MethodPost, path: "/v2/admin/tools/restart", want: http.StatusAccepted},
		{name: "telemetry_requests", method: http.MethodGet, path: "/v2/admin/telemetry/requests?period=1h&bucket=5m&limit=10&group_by=provider", want: http.StatusOK},
		{name: "telemetry_errors", method: http.MethodGet, path: "/v2/admin/telemetry/errors", want: http.StatusOK},
		{name: "telemetry_upstream", method: http.MethodGet, path: "/v2/admin/telemetry/upstream", want: http.StatusOK},
		{name: "telemetry_usage", method: http.MethodGet, path: "/v2/admin/telemetry/usage", want: http.StatusOK},
		{name: "telemetry_clients", method: http.MethodGet, path: "/v2/admin/telemetry/clients", want: http.StatusOK},
		{name: "catalog_models", method: http.MethodGet, path: "/v2/admin/catalog/models?providerId=openai", want: http.StatusOK},
		{name: "custom_get", method: http.MethodGet, path: "/v2/admin/custom-providers/cp-1", want: http.StatusOK},
		{name: "custom_put", method: http.MethodPut, path: "/v2/admin/custom-providers/cp-2", body: `{"slug":"cp2","name":"CP2","type":"openai","protocol":"openai","surface":"chat","baseUrl":"https://example.test","credentialRef":"ref","models":[]}`, want: http.StatusOK},
		{name: "custom_delete", method: http.MethodDelete, path: "/v2/admin/custom-providers/cp-2", want: http.StatusOK},
		{name: "method_not_allowed_accounts", method: http.MethodPut, path: "/v2/admin/accounts", want: http.StatusBadRequest},
		{name: "method_not_allowed_dashboard", method: http.MethodPost, path: "/v2/admin/dashboard", want: http.StatusBadRequest},
		{name: "account_unknown_sub", method: http.MethodGet, path: "/v2/admin/accounts/acct-1/unknown", want: http.StatusNotFound},
		{name: "key_unknown_sub", method: http.MethodGet, path: "/v2/admin/keys/key-1/unknown", want: http.StatusNotFound},
		{name: "proxy_unknown_sub", method: http.MethodGet, path: "/v2/admin/proxies/proxy-1/unknown", want: http.StatusNotFound},
		{name: "backup_unknown_sub", method: http.MethodGet, path: "/v2/admin/backups/bkp-1/unknown", want: http.StatusNotFound},
		{name: "tools_cache_missing", method: http.MethodPost, path: "/v2/admin/tools/cache/", want: http.StatusBadRequest},
		{name: "oauth_start_missing_provider", method: http.MethodPost, path: "/v2/admin/auth/oauth/start", body: `{}`, want: http.StatusBadRequest},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := strings.NewReader(tc.body)
			req := withSession(httptest.NewRequest(tc.method, tc.path, body))
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			req.Header.Set("X-Forwarded-Host", "admin.example.test")
			req.Header.Set("X-Forwarded-Proto", "https")
			req.Header.Set("X-Request-Id", "req-matrix-1")
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertNoSecrets(t, rec.Body.String())
			if strings.Contains(tc.name, "keys_create") || strings.Contains(tc.name, "keys_regenerate") {
				if strings.Contains(rec.Body.String(), matrixSecretMarker) {
					t.Fatalf("API key material leaked: %s", rec.Body.String())
				}
			}
		})
	}
}

func TestAdminRouteMatrixSessionAuthorizerAndScopes(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, Services{
		Dashboard:  testDashboard{},
		Settings:   testSettings{},
		Auth:       matrixAuthService{scopes: []string{"admin:health"}},
		Audit:      &testAudit{},
		Generation: &testGeneration{},
	})

	okReq := withSession(httptest.NewRequest(http.MethodGet, "/v2/admin/dashboard", nil))
	okRec := httptest.NewRecorder()
	mux.ServeHTTP(okRec, okReq)
	if okRec.Code != http.StatusOK {
		t.Fatalf("health scope status=%d body=%s", okRec.Code, okRec.Body.String())
	}

	denied := withSession(httptest.NewRequest(http.MethodGet, "/v2/admin/settings", nil))
	deniedRec := httptest.NewRecorder()
	mux.ServeHTTP(deniedRec, denied)
	if deniedRec.Code != http.StatusForbidden {
		t.Fatalf("denied status=%d body=%s", deniedRec.Code, deniedRec.Body.String())
	}
	assertNoSecrets(t, deniedRec.Body.String())

	// Mutation denied should still audit without secrets.
	mut := withSession(httptest.NewRequest(http.MethodPatch, "/v2/admin/settings", strings.NewReader(`{"logLevel":"info"}`)))
	mut.Header.Set("Content-Type", "application/json")
	mutRec := httptest.NewRecorder()
	mux.ServeHTTP(mutRec, mut)
	if mutRec.Code != http.StatusForbidden {
		t.Fatalf("mutation denied status=%d", mutRec.Code)
	}
}

func TestAdminRouteMatrixCustomProviderErrorRedaction(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, Services{
		Dashboard:       testDashboard{},
		CustomProviders: matrixFailingCustomProviders{},
		Authorizer:      matrixAuthorizer{},
	})

	req := withSession(httptest.NewRequest(http.MethodGet, "/v2/admin/custom-providers", nil))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertNoSecrets(t, rec.Body.String())

	badID := withSession(httptest.NewRequest(http.MethodGet, "/v2/admin/custom-providers/bad/nested", nil))
	badRec := httptest.NewRecorder()
	mux.ServeHTTP(badRec, badID)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("invalid id status=%d body=%s", badRec.Code, badRec.Body.String())
	}

	put := withSession(httptest.NewRequest(http.MethodPut, "/v2/admin/custom-providers/cp-x", strings.NewReader(`{"slug":"x","name":"x","type":"openai","protocol":"openai","surface":"chat","baseUrl":"https://example.test","models":[]}`)))
	put.Header.Set("Content-Type", "application/json")
	putRec := httptest.NewRecorder()
	mux.ServeHTTP(putRec, put)
	if putRec.Code != http.StatusServiceUnavailable {
		t.Fatalf("upsert status=%d body=%s", putRec.Code, putRec.Body.String())
	}
	assertNoSecrets(t, putRec.Body.String())
}

func TestAdminRouteMatrixEnvelopeAndValidationHelpers(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteOK(rec)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("WriteOK bare: %s", rec.Body.String())
	}

	rec2 := httptest.NewRecorder()
	WriteOK(rec2, map[string]any{"deleted": true})
	if !strings.Contains(rec2.Body.String(), `"deleted":true`) {
		t.Fatalf("WriteOK payload: %s", rec2.Body.String())
	}

	rec3 := httptest.NewRecorder()
	WriteOK(rec3, map[string]any{"a": 1}, map[string]any{"b": 2})
	if !strings.Contains(rec3.Body.String(), `"a":1`) || !strings.Contains(rec3.Body.String(), `"b":2`) {
		t.Fatalf("WriteOK merge: %s", rec3.Body.String())
	}

	rec4 := httptest.NewRecorder()
	WriteStatus(rec4, http.StatusNoContent)
	if rec4.Code != http.StatusNoContent {
		t.Fatalf("WriteStatus=%d", rec4.Code)
	}

	rec5 := httptest.NewRecorder()
	WriteError(rec5, nil)
	if rec5.Code != http.StatusOK {
		t.Fatalf("WriteError(nil)=%d", rec5.Code)
	}

	for _, code := range []ErrorCode{CodeConflict, CodeRateLimited, CodeNotFound, CodeOK, ErrorCode("unknown")} {
		rec := httptest.NewRecorder()
		WriteError(rec, NewError(code, "safe"))
		if rec.Body.Len() == 0 {
			t.Fatalf("empty body for %s", code)
		}
	}

	details := safeOperatorDetails(map[string]any{
		"authorization": matrixSecretMarker,
		"nested":        map[string]any{"password=": "password=" + matrixSecretMarker, "ok": "value"},
		"list":          []any{"safe", "Bearer " + matrixSecretMarker},
	})
	encoded, _ := json.Marshal(details)
	assertNoSecrets(t, string(encoded))
	if details["authorization"] != "[REDACTED]" {
		t.Fatalf("authorization detail not redacted: %#v", details["authorization"])
	}

	if err := validateAdminPayload(&AccountInput{Label: strings.Repeat("x", 300)}); err == nil {
		t.Fatal("expected account validation error")
	}
	if err := validateAdminPayload(&APIKeyInput{Scopes: make([]string, 65)}); err == nil {
		t.Fatal("expected api key validation error")
	}
	if err := validateAdminPayload(&ProxyInput{Protocol: "http", Host: "bad host", Port: 80}); err == nil {
		t.Fatal("expected proxy host validation error")
	}
	if err := validateAdminPayload(&ProxyInput{Protocol: "http", Host: "127.0.0.1", Port: 0}); err == nil {
		t.Fatal("expected proxy port validation error")
	}
	mode := strings.Repeat("m", 300)
	if err := validateAdminPayload(&ProxySettingsInput{Mode: &mode}); err == nil {
		t.Fatal("expected proxy settings validation error")
	}
	listen := "not-a-listen-addr"
	if err := validateAdminPayload(&RuntimeSettingsInput{ListenAddr: &listen}); err == nil {
		t.Fatal("expected listen addr validation error")
	}
	if err := validateAdminPayload(&BackupCreateInput{Note: strings.Repeat("n", 300)}); err == nil {
		t.Fatal("expected backup validation error")
	}
	if err := validateAdminPayload(&ProbeInput{URL: "https://example.test", Body: strings.Repeat("b", 65*1024)}); err == nil {
		t.Fatal("expected probe body validation error")
	}
	if err := validateAdminPayload(&OAuthStartInput{Scopes: []string{strings.Repeat("s", 300)}}); err == nil {
		t.Fatal("expected oauth start validation error")
	}
	if err := validateAdminPayload(&OAuthCompleteInput{}); err == nil {
		t.Fatal("expected oauth complete validation error")
	}
	if err := validateAdminPayload(&OAuthRefreshInput{}); err == nil {
		t.Fatal("expected oauth refresh validation error")
	}
	if err := validateAdminPayload(&RestoreOptions{}); err != nil {
		t.Fatalf("restore options should pass: %v", err)
	}
	meta := map[string]any{}
	for i := 0; i < 65; i++ {
		meta[strings.Repeat("k", i+1)] = true
	}
	if err := validateMetadata(meta); err == nil {
		t.Fatal("expected metadata size error")
	}

	if statusForAdminError(errors.New("x")) != http.StatusInternalServerError {
		t.Fatal("statusForAdminError plain")
	}
	if statusForAdminError(NewError(CodeAdminAuthentication, "x")) != http.StatusUnauthorized {
		t.Fatal("statusForAdminError auth")
	}
	if statusForAdminError(NewError(CodeAdminForbidden, "x")) != http.StatusForbidden {
		t.Fatal("statusForAdminError forbidden")
	}
	if statusForAdminError(NewError(CodeAdminInvalidRequest, "x")) != http.StatusBadRequest {
		t.Fatal("statusForAdminError invalid")
	}
	if statusForAdminError(NewError(CodeAdminUnavailable, "x")) != http.StatusServiceUnavailable {
		t.Fatal("statusForAdminError unavailable")
	}
	if statusForAdminError(NewError(CodeNotFound, "x")) != http.StatusNotFound {
		t.Fatal("statusForAdminError default mapping")
	}

	if !hasScope([]string{"*"}, ScopeConfig) || !hasScope([]string{"admin"}, ScopeConfig) || !hasScope([]string{"admin:*"}, ScopeConfig) {
		t.Fatal("hasScope wildcard")
	}
	if hasScope([]string{"admin:keys"}, ScopeConfig) {
		t.Fatal("hasScope should deny mismatched scope")
	}
	if boundedAuditField(strings.Repeat("z", 300)) != strings.Repeat("z", 256) {
		t.Fatal("boundedAuditField truncate")
	}

	req := httptest.NewRequest(http.MethodGet, "http://example.test/v2/admin/dashboard?sessionId=from-query", nil)
	req.Header.Set("X-Real-IP", "198.51.100.7")
	if got := readSessionID(req); got != "from-query" {
		t.Fatalf("readSessionID query=%q", got)
	}
	req2 := httptest.NewRequest(http.MethodGet, "http://example.test/", nil)
	req2.AddCookie(&http.Cookie{Name: "cartethyia_session", Value: "cookie-session"})
	if got := readSessionID(req2); got != "cookie-session" {
		t.Fatalf("readSessionID cookie=%q", got)
	}
	authReq := buildAuthRequest(req)
	if authReq.IP != "198.51.100.7" {
		t.Fatalf("clientIP real=%q", authReq.IP)
	}
	req3 := httptest.NewRequest(http.MethodGet, "http://example.test/", nil)
	req3.Header.Set("X-Forwarded-For", "203.0.113.9")
	if got := clientIP(req3); got != "203.0.113.9" {
		t.Fatalf("clientIP single=%q", got)
	}
	req4 := httptest.NewRequest(http.MethodGet, "http://example.test/", nil)
	req4.RemoteAddr = "192.0.2.1:1234"
	if got := clientIP(req4); got != "192.0.2.1:1234" {
		t.Fatalf("clientIP remote=%q", got)
	}
	req5 := httptest.NewRequest(http.MethodGet, "https://example.test/", nil)
	req5.TLS = &tls.ConnectionState{}
	if base := baseURLFromRequest(req5); !strings.HasPrefix(base, "https://") {
		t.Fatalf("baseURL tls=%q", base)
	}

	writeMethodNotAllowed(httptest.NewRecorder(), http.MethodGet)
	_ = dummyResponseWriter{}.Header()
	_, _ = dummyResponseWriter{}.Write(nil)
	dummyResponseWriter{}.WriteHeader(0)

	if adminScopeForPath("/v2/admin/auth/login") != ScopeAuth {
		t.Fatal("scope auth")
	}
	if adminScopeForPath("/v2/admin/keys/x") != ScopeKeys {
		t.Fatal("scope keys")
	}
	if adminScopeForPath("/v2/admin/tools/cache/x") != ScopeCache {
		t.Fatal("scope cache")
	}
	if adminScopeForPath("/v2/admin/tools/restart") != ScopeLifecycle {
		t.Fatal("scope lifecycle")
	}
	if adminScopeForPath("/v2/admin/backups") != ScopeBackups {
		t.Fatal("scope backups")
	}
	if generationScope("/v2/admin/keys") != "credentials" {
		t.Fatal("generation keys")
	}
	if generationScope("/v2/admin/backups/x/restore") != "backup" {
		t.Fatal("generation backup")
	}
	if generationScope("/v2/admin/tools/cache/x") != "cache" {
		t.Fatal("generation cache")
	}
	if generationScope("/v2/admin/tools/reindex") != "lifecycle" {
		t.Fatal("generation lifecycle")
	}
	if !isGenerationMutation("/v2/admin/backups/x/restore", http.MethodPost) {
		t.Fatal("restore generation mutation")
	}
	if isGenerationMutation("/v2/admin/dashboard", http.MethodGet) {
		t.Fatal("get should not mutate generation")
	}
}

func TestAdminRouteMatrixNilServiceRegistrationIsAbsent(t *testing.T) {
	mux := http.NewServeMux()
	RegisterAccounts(mux, Services{})
	RegisterAPIKeys(mux, Services{})
	RegisterProxies(mux, Services{})
	RegisterSettings(mux, Services{})
	RegisterBackup(mux, Services{})
	RegisterTools(mux, Services{})
	RegisterAuth(mux, Services{})
	RegisterTelemetry(mux, Services{})
	RegisterConsole(mux, Services{})
	RegisterUsage(mux, Services{})

	req := httptest.NewRequest(http.MethodGet, "/v2/admin/accounts", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("nil accounts should leave route unregistered, got %d", rec.Code)
	}
}

func TestAdminRouteMatrixDecodeJSONErrors(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, matrixServices())
	req := withSession(httptest.NewRequest(http.MethodPatch, "/v2/admin/settings", strings.NewReader(`{"logLevel":`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertNoSecrets(t, rec.Body.String())
}

func TestAdminRouteMatrixLoginUsesBuildAuthRequest(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, matrixServices())
	req := httptest.NewRequest(http.MethodPost, "/v2/admin/auth/login", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", "203.0.113.55, 10.0.0.2")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "console.example.test")
	req.RemoteAddr = "127.0.0.1:9999"
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Set-Cookie"); !strings.Contains(got, "cartethyia_session=") {
		t.Fatalf("missing set-cookie: %q", got)
	}
}
