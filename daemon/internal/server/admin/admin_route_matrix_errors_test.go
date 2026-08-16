package admin

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
	"github.com/cartethyia/daemon/internal/accounts/flow"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

type failingAccounts struct{ matrixAccounts }

func (failingAccounts) List(context.Context, string) ([]contracts.Account, error) {
	return nil, NewError(CodeUnavailable, "list failed")
}
func (failingAccounts) Create(context.Context, string, AccountInput) (contracts.Account, error) {
	return contracts.Account{}, NewError(CodeUnavailable, "create failed")
}
func (failingAccounts) Update(context.Context, string, string, AccountInput) (contracts.Account, error) {
	return contracts.Account{}, NewError(CodeUnavailable, "update failed")
}
func (failingAccounts) Delete(context.Context, string, string) error {
	return NewError(CodeUnavailable, "delete failed")
}
func (failingAccounts) BatchCreate(context.Context, string, []AccountInput) ([]contracts.Account, error) {
	return nil, NewError(CodeUnavailable, "batch create failed")
}
func (failingAccounts) BatchUpdate(context.Context, string, []AccountBatchPatch) (BatchResult, error) {
	return BatchResult{}, NewError(CodeUnavailable, "batch update failed")
}
func (failingAccounts) BatchDelete(context.Context, string, []string) (BatchResult, error) {
	return BatchResult{}, NewError(CodeUnavailable, "batch delete failed")
}
func (failingAccounts) RefreshQuota(context.Context, string) (QuotaState, error) {
	return QuotaState{}, NewError(CodeUnavailable, "quota refresh failed")
}
func (failingAccounts) RefreshAllQuotas(context.Context, QuotaRefreshRequest) (BatchResult, error) {
	return BatchResult{}, NewError(CodeUnavailable, "quota refresh all failed")
}
func (failingAccounts) Quota(context.Context, string) (QuotaState, error) {
	return QuotaState{}, NewError(CodeUnavailable, "quota failed")
}
func (failingAccounts) Revoke(context.Context, string) error {
	return NewError(CodeUnavailable, "revoke failed")
}
func (failingAccounts) RevokeForProvider(context.Context, string, string) error {
	return NewError(CodeUnavailable, "provider revoke failed")
}
func (failingAccounts) OAuthStatus(context.Context, string) (OAuthState, error) {
	return OAuthState{}, NewError(CodeUnavailable, "oauth status failed")
}

type failingAPIKeys struct{ matrixAPIKeys }

func (failingAPIKeys) List(context.Context) ([]APIKey, error) {
	return nil, NewError(CodeUnavailable, "keys list failed")
}
func (failingAPIKeys) Create(context.Context, APIKeyInput) (APIKeyCreateResult, error) {
	return APIKeyCreateResult{}, NewError(CodeUnavailable, "keys create failed")
}
func (failingAPIKeys) Update(context.Context, string, APIKeyInput) (APIKey, error) {
	return APIKey{}, NewError(CodeUnavailable, "keys update failed")
}
func (failingAPIKeys) Delete(context.Context, string) error {
	return NewError(CodeUnavailable, "keys delete failed")
}
func (failingAPIKeys) Regenerate(context.Context, string) (APIKeyCreateResult, error) {
	return APIKeyCreateResult{}, NewError(CodeUnavailable, "keys regenerate failed")
}
func (failingAPIKeys) Revoke(context.Context, string) error {
	return NewError(CodeUnavailable, "keys revoke failed")
}
func (failingAPIKeys) ShareLink(context.Context, string, string, string) (ShareLink, error) {
	return ShareLink{}, NewError(CodeUnavailable, "share failed")
}
func (failingAPIKeys) RevokeShareLinks(context.Context, string) (int, error) {
	return 0, NewError(CodeUnavailable, "revoke share failed")
}

type failingProxies struct{ matrixProxies }

func (failingProxies) List(context.Context, int) ([]Proxy, error) {
	return nil, NewError(CodeUnavailable, "proxy list failed")
}
func (failingProxies) Create(context.Context, ProxyInput) (Proxy, error) {
	return Proxy{}, NewError(CodeUnavailable, "proxy create failed")
}
func (failingProxies) Update(context.Context, string, ProxyInput) (Proxy, error) {
	return Proxy{}, NewError(CodeUnavailable, "proxy update failed")
}
func (failingProxies) Delete(context.Context, string) error {
	return NewError(CodeUnavailable, "proxy delete failed")
}
func (failingProxies) Test(context.Context, string) (ProxyTestResult, error) {
	return ProxyTestResult{}, NewError(CodeUnavailable, "proxy test failed")
}
func (failingProxies) Search(context.Context, ProxySearchInput) ([]Proxy, error) {
	return nil, NewError(CodeUnavailable, "proxy search failed")
}
func (failingProxies) Import(context.Context, ProxyImportInput) (BatchResult, error) {
	return BatchResult{}, NewError(CodeUnavailable, "proxy import failed")
}
func (failingProxies) Scrape(context.Context, ProxyScrapeInput) (BatchResult, error) {
	return BatchResult{}, NewError(CodeUnavailable, "proxy scrape failed")
}
func (failingProxies) Settings(context.Context) (ProxySettings, error) {
	return ProxySettings{}, NewError(CodeUnavailable, "proxy settings failed")
}
func (failingProxies) PatchSettings(context.Context, ProxySettingsInput) (ProxySettings, error) {
	return ProxySettings{}, NewError(CodeUnavailable, "proxy settings patch failed")
}
func (failingProxies) Countries(context.Context) ([]string, error) {
	return nil, NewError(CodeUnavailable, "countries failed")
}

type failingBackup struct{ matrixBackup }

func (failingBackup) List(context.Context) ([]BackupRecord, error) {
	return nil, NewError(CodeUnavailable, "backup list failed")
}
func (failingBackup) Create(context.Context, BackupCreateInput) (BackupRecord, error) {
	return BackupRecord{}, NewError(CodeUnavailable, "backup create failed")
}
func (failingBackup) Download(context.Context, string) (BackupArtifact, error) {
	return BackupArtifact{}, NewError(CodeUnavailable, "backup download failed")
}
func (failingBackup) Restore(context.Context, string, RestoreOptions) (RestoreResult, error) {
	return RestoreResult{}, NewError(CodeUnavailable, "backup restore failed")
}
func (failingBackup) Delete(context.Context, string) error {
	return NewError(CodeUnavailable, "backup delete failed")
}

type failingSettings struct{}

func (failingSettings) Get(context.Context) (RuntimeSettings, error) {
	return RuntimeSettings{}, NewError(CodeUnavailable, "settings get failed")
}
func (failingSettings) Patch(context.Context, RuntimeSettingsInput) (RuntimeSettings, error) {
	return RuntimeSettings{}, NewError(CodeUnavailable, "settings patch failed")
}
func (failingSettings) Reset(context.Context) (RuntimeSettings, error) {
	return RuntimeSettings{}, NewError(CodeUnavailable, "settings reset failed")
}

type failingConsoleLogs struct{}

func (failingConsoleLogs) List(context.Context, ConsoleLogQuery) ([]ConsoleLogEntry, error) {
	return nil, NewError(CodeUnavailable, "console failed")
}

type failingWebRequest struct{}

func (failingWebRequest) Execute(context.Context, WebRequestInput) (WebRequestResult, error) {
	return WebRequestResult{}, NewError(CodeUnavailable, "web request failed")
}

type failingAuthNoStatus struct{}

func (failingAuthNoStatus) Login(context.Context, LoginInput, AuthRequest) (LoginResult, error) {
	return LoginResult{}, NewError(CodeUnavailable, "login failed")
}
func (failingAuthNoStatus) Logout(context.Context, string) error {
	return NewError(CodeUnavailable, "logout failed")
}
func (failingAuthNoStatus) Current(context.Context, string) (Session, error) {
	return Session{}, NewError(CodeUnavailable, "session failed")
}
func (failingAuthNoStatus) Refresh(context.Context, string) (Session, error) {
	return Session{}, NewError(CodeUnavailable, "refresh failed")
}
func (failingAuthNoStatus) OAuthStart(context.Context, string, OAuthStartInput) (OAuthState, error) {
	return OAuthState{}, NewError(CodeUnavailable, "oauth start failed")
}
func (failingAuthNoStatus) OAuthComplete(context.Context, string, OAuthCompleteInput) (OAuthState, error) {
	return OAuthState{}, NewError(CodeUnavailable, "oauth complete failed")
}
func (failingAuthNoStatus) OAuthCancel(context.Context, string) error {
	return NewError(CodeUnavailable, "oauth cancel failed")
}
func (failingAuthNoStatus) OAuthRefresh(context.Context, OAuthRefreshInput) (OAuthState, error) {
	return OAuthState{}, NewError(CodeUnavailable, "oauth refresh failed")
}

type failingGeneration struct{}

func (failingGeneration) Publish(context.Context, string) error {
	return errors.New("publish failed")
}

func TestAdminRouteMatrixMethodNotAllowedAndEmptyIDs(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, matrixServices())

	cases := []struct {
		name   string
		method string
		path   string
		body   string
		want   int
	}{
		{name: "account_get_method", method: http.MethodGet, path: "/v2/admin/accounts/acct-1", want: http.StatusBadRequest},
		{name: "account_quota_put", method: http.MethodPut, path: "/v2/admin/accounts/acct-1/quota", want: http.StatusBadRequest},
		{name: "account_revoke_get", method: http.MethodGet, path: "/v2/admin/accounts/acct-1/revoke", want: http.StatusBadRequest},
		{name: "account_oauth_post", method: http.MethodPost, path: "/v2/admin/accounts/acct-1/oauth-status", want: http.StatusBadRequest},
		{name: "account_empty_id", method: http.MethodDelete, path: "/v2/admin/accounts/", want: http.StatusNotFound},
		{name: "provider_put", method: http.MethodPut, path: "/v2/admin/providers/openai/accounts", want: http.StatusBadRequest},
		{name: "provider_batch_get", method: http.MethodGet, path: "/v2/admin/providers/openai/accounts/batch", want: http.StatusBadRequest},
		{name: "provider_batch_delete_get", method: http.MethodGet, path: "/v2/admin/providers/openai/accounts/batch-delete", want: http.StatusBadRequest},
		{name: "provider_account_get", method: http.MethodGet, path: "/v2/admin/providers/openai/accounts/acct-1", want: http.StatusBadRequest},
		{name: "provider_revoke_get", method: http.MethodGet, path: "/v2/admin/providers/openai/accounts/acct-1/revoke", want: http.StatusBadRequest},
		{name: "provider_missing_accounts", method: http.MethodGet, path: "/v2/admin/providers/openai/other", want: http.StatusNotFound},
		{name: "provider_oauth_as_account_post", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/oauth", body: `{"label":"x"}`, want: http.StatusOK},
		{name: "provider_oauth_as_account_get", method: http.MethodGet, path: "/v2/admin/providers/openai/accounts/oauth", want: http.StatusBadRequest},
		{name: "keys_get_one", method: http.MethodGet, path: "/v2/admin/keys/key-1", want: http.StatusBadRequest},
		{name: "keys_regenerate_get", method: http.MethodGet, path: "/v2/admin/keys/key-1/regenerate", want: http.StatusBadRequest},
		{name: "keys_share_get", method: http.MethodGet, path: "/v2/admin/keys/key-1/share", want: http.StatusBadRequest},
		{name: "keys_revoke_share_post", method: http.MethodPost, path: "/v2/admin/keys/key-1/revoke-share", want: http.StatusBadRequest},
		{name: "keys_empty", method: http.MethodDelete, path: "/v2/admin/keys/", want: http.StatusNotFound},
		{name: "proxy_get_one", method: http.MethodGet, path: "/v2/admin/proxies/proxy-1", want: http.StatusBadRequest},
		{name: "proxy_test_get", method: http.MethodGet, path: "/v2/admin/proxies/proxy-1/test", want: http.StatusBadRequest},
		{name: "proxy_empty", method: http.MethodDelete, path: "/v2/admin/proxies/", want: http.StatusNotFound},
		{name: "backup_get_one", method: http.MethodGet, path: "/v2/admin/backups/bkp-1", want: http.StatusBadRequest},
		{name: "backup_put", method: http.MethodPut, path: "/v2/admin/backups/bkp-1", want: http.StatusBadRequest},
		{name: "backup_download_post", method: http.MethodPost, path: "/v2/admin/backups/bkp-1/download", want: http.StatusBadRequest},
		{name: "backup_restore_get", method: http.MethodGet, path: "/v2/admin/backups/bkp-1/restore", want: http.StatusBadRequest},
		{name: "backup_empty", method: http.MethodDelete, path: "/v2/admin/backups/", want: http.StatusNotFound},
		{name: "oauth_session_empty", method: http.MethodGet, path: "/v2/admin/auth/oauth/sessions/", want: http.StatusNotFound},
		{name: "oauth_session_unknown", method: http.MethodGet, path: "/v2/admin/auth/oauth/sessions/s1/weird", want: http.StatusNotFound},
		{name: "oauth_status_post", method: http.MethodPost, path: "/v2/admin/auth/oauth/sessions/s1/status", want: http.StatusBadRequest},
		{name: "oauth_complete_get", method: http.MethodGet, path: "/v2/admin/auth/oauth/sessions/s1/complete", want: http.StatusBadRequest},
		{name: "oauth_cancel_get", method: http.MethodGet, path: "/v2/admin/auth/oauth/sessions/s1/cancel", want: http.StatusBadRequest},
		{name: "oauth_session_too_long", method: http.MethodGet, path: "/v2/admin/auth/oauth/sessions/" + strings.Repeat("s", 300), want: http.StatusBadRequest},
		{name: "oauth_bare_session", method: http.MethodGet, path: "/v2/admin/auth/oauth/sessions/s1", want: http.StatusOK},
		{name: "proxies_limit", method: http.MethodGet, path: "/v2/admin/proxies?limit=5", want: http.StatusOK},
		{name: "proxies_bad_limit", method: http.MethodGet, path: "/v2/admin/proxies?limit=abc", want: http.StatusOK},
		{name: "auth_login_wrong_method", method: http.MethodGet, path: "/v2/admin/auth/login", want: http.StatusUnauthorized},
		{name: "match_method_fold", method: http.MethodGet, path: "/v2/admin/accounts", want: http.StatusOK},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var body io.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			}
			req := httptest.NewRequest(tc.method, tc.path, body)
			if tc.path != "/v2/admin/auth/login" {
				withSession(req)
			}
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertNoSecrets(t, rec.Body.String())
		})
	}
}

func TestAdminRouteMatrixServiceErrorPaths(t *testing.T) {
	svc := matrixServices()
	svc.Accounts = failingAccounts{}
	svc.APIKeys = failingAPIKeys{}
	svc.Proxies = failingProxies{}
	svc.Backup = failingBackup{}
	svc.Settings = failingSettings{}
	svc.ConsoleLogs = failingConsoleLogs{}
	svc.WebRequest = failingWebRequest{}
	svc.Auth = failingAuthNoStatus{}
	svc.OAuth = failingAuthNoStatus{}
	svc.Generation = failingGeneration{}

	mux := http.NewServeMux()
	Register(mux, svc)

	cases := []struct {
		name   string
		method string
		path   string
		body   string
		want   int
	}{
		{name: "accounts_list", method: http.MethodGet, path: "/v2/admin/accounts", want: http.StatusServiceUnavailable},
		{name: "accounts_patch", method: http.MethodPatch, path: "/v2/admin/accounts/a1", body: `{"name":"x"}`, want: http.StatusServiceUnavailable},
		{name: "accounts_delete", method: http.MethodDelete, path: "/v2/admin/accounts/a1", want: http.StatusServiceUnavailable},
		{name: "accounts_quota", method: http.MethodGet, path: "/v2/admin/accounts/a1/quota", want: http.StatusServiceUnavailable},
		{name: "accounts_quota_post", method: http.MethodPost, path: "/v2/admin/accounts/a1/quota", want: http.StatusServiceUnavailable},
		{name: "accounts_revoke", method: http.MethodPost, path: "/v2/admin/accounts/a1/revoke", want: http.StatusServiceUnavailable},
		{name: "accounts_oauth", method: http.MethodGet, path: "/v2/admin/accounts/a1/oauth-status", want: http.StatusServiceUnavailable},
		{name: "quota_all", method: http.MethodPost, path: "/v2/admin/quota/refresh", body: `{}`, want: http.StatusServiceUnavailable},
		{name: "provider_list", method: http.MethodGet, path: "/v2/admin/providers/openai/accounts", want: http.StatusServiceUnavailable},
		{name: "provider_create", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts", body: `{"label":"x"}`, want: http.StatusServiceUnavailable},
		{name: "provider_batch", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/batch", body: `{"items":[{"label":"x"}]}`, want: http.StatusServiceUnavailable},
		{name: "provider_batch_patch", method: http.MethodPatch, path: "/v2/admin/providers/openai/accounts/batch", body: `{"items":[{"accountId":"a1"}]}`, want: http.StatusServiceUnavailable},
		{name: "provider_batch_delete", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/batch-delete", body: `{"items":["a1"]}`, want: http.StatusServiceUnavailable},
		{name: "provider_update", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/a1", body: `{"name":"x"}`, want: http.StatusServiceUnavailable},
		{name: "provider_delete", method: http.MethodDelete, path: "/v2/admin/providers/openai/accounts/a1", want: http.StatusServiceUnavailable},
		{name: "provider_revoke", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/a1/revoke", want: http.StatusServiceUnavailable},
		{name: "keys_list", method: http.MethodGet, path: "/v2/admin/keys", want: http.StatusServiceUnavailable},
		{name: "keys_create", method: http.MethodPost, path: "/v2/admin/keys", body: `{"name":"x"}`, want: http.StatusServiceUnavailable},
		{name: "keys_patch", method: http.MethodPatch, path: "/v2/admin/keys/k1", body: `{"name":"x"}`, want: http.StatusServiceUnavailable},
		{name: "keys_delete", method: http.MethodDelete, path: "/v2/admin/keys/k1", want: http.StatusServiceUnavailable},
		{name: "keys_regen", method: http.MethodPost, path: "/v2/admin/keys/k1/regenerate", want: http.StatusServiceUnavailable},
		{name: "keys_revoke", method: http.MethodPost, path: "/v2/admin/keys/k1/revoke", want: http.StatusServiceUnavailable},
		{name: "keys_share", method: http.MethodPost, path: "/v2/admin/keys/k1/share", want: http.StatusServiceUnavailable},
		{name: "keys_revoke_share", method: http.MethodDelete, path: "/v2/admin/keys/k1/revoke-share", want: http.StatusServiceUnavailable},
		{name: "proxies_list", method: http.MethodGet, path: "/v2/admin/proxies", want: http.StatusServiceUnavailable},
		{name: "proxies_create", method: http.MethodPost, path: "/v2/admin/proxies", body: `{"protocol":"http","host":"127.0.0.1","port":1}`, want: http.StatusServiceUnavailable},
		{name: "proxies_patch", method: http.MethodPatch, path: "/v2/admin/proxies/p1", body: `{"protocol":"http","host":"127.0.0.1","port":1}`, want: http.StatusServiceUnavailable},
		{name: "proxies_delete", method: http.MethodDelete, path: "/v2/admin/proxies/p1", want: http.StatusServiceUnavailable},
		{name: "proxies_test", method: http.MethodPost, path: "/v2/admin/proxies/p1/test", want: http.StatusServiceUnavailable},
		{name: "proxies_search", method: http.MethodPost, path: "/v2/admin/proxies/search", body: `{}`, want: http.StatusServiceUnavailable},
		{name: "proxies_import", method: http.MethodPost, path: "/v2/admin/proxies/import", body: `{"proxies":[]}`, want: http.StatusServiceUnavailable},
		{name: "proxies_scrape", method: http.MethodPost, path: "/v2/admin/proxies/scrape", body: `{}`, want: http.StatusServiceUnavailable},
		{name: "proxies_countries", method: http.MethodGet, path: "/v2/admin/proxies/scrape/countries", want: http.StatusServiceUnavailable},
		{name: "proxy_settings", method: http.MethodGet, path: "/v2/admin/proxy-settings", want: http.StatusServiceUnavailable},
		{name: "proxy_settings_patch", method: http.MethodPost, path: "/v2/admin/proxy-settings", body: `{"mode":"auto"}`, want: http.StatusServiceUnavailable},
		{name: "web_search", method: http.MethodGet, path: "/v2/admin/web-search-routing", want: http.StatusServiceUnavailable},
		{name: "settings_get", method: http.MethodGet, path: "/v2/admin/settings", want: http.StatusServiceUnavailable},
		{name: "settings_patch", method: http.MethodPatch, path: "/v2/admin/settings", body: `{"logLevel":"info"}`, want: http.StatusServiceUnavailable},
		{name: "settings_reset", method: http.MethodPost, path: "/v2/admin/settings", want: http.StatusServiceUnavailable},
		{name: "backup_list", method: http.MethodGet, path: "/v2/admin/backups", want: http.StatusServiceUnavailable},
		{name: "backup_create", method: http.MethodPost, path: "/v2/admin/backups", body: `{"note":"n"}`, want: http.StatusServiceUnavailable},
		{name: "backup_download", method: http.MethodGet, path: "/v2/admin/backups/b1/download", want: http.StatusServiceUnavailable},
		{name: "backup_restore", method: http.MethodPost, path: "/v2/admin/backups/b1/restore", body: `{}`, want: http.StatusServiceUnavailable},
		{name: "backup_delete", method: http.MethodDelete, path: "/v2/admin/backups/b1", want: http.StatusServiceUnavailable},
		{name: "console_logs", method: http.MethodGet, path: "/v2/admin/console/logs", want: http.StatusServiceUnavailable},
		{name: "web_request", method: http.MethodPost, path: "/v2/admin/console/web-request", body: `{"url":"https://example.test"}`, want: http.StatusServiceUnavailable},
		{name: "auth_logout", method: http.MethodPost, path: "/v2/admin/auth/logout", want: http.StatusServiceUnavailable},
		{name: "auth_session", method: http.MethodGet, path: "/v2/admin/auth/session", want: http.StatusServiceUnavailable},
		{name: "auth_refresh", method: http.MethodPost, path: "/v2/admin/auth/refresh", want: http.StatusServiceUnavailable},
		{name: "oauth_start", method: http.MethodPost, path: "/v2/admin/auth/oauth/start?providerId=openai", body: `{}`, want: http.StatusServiceUnavailable},
		{name: "oauth_status", method: http.MethodGet, path: "/v2/admin/auth/oauth/sessions/s1/status", want: http.StatusServiceUnavailable},
		{name: "oauth_complete", method: http.MethodPost, path: "/v2/admin/auth/oauth/sessions/s1/complete", body: `{"code":"c","state":"s"}`, want: http.StatusServiceUnavailable},
		{name: "oauth_cancel", method: http.MethodPost, path: "/v2/admin/auth/oauth/sessions/s1/cancel", want: http.StatusServiceUnavailable},
		{name: "oauth_refresh", method: http.MethodPost, path: "/v2/admin/auth/oauth/refresh", body: `{"accountId":"a1"}`, want: http.StatusServiceUnavailable},
		{name: "oauth_reauth", method: http.MethodPost, path: "/v2/admin/auth/oauth/reauth", body: `{"accountId":"a1"}`, want: http.StatusServiceUnavailable},
		{name: "generation_fail", method: http.MethodPost, path: "/v2/admin/tools/reindex", body: `{"target":"catalog"}`, want: http.StatusServiceUnavailable},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var body io.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			}
			req := withSession(httptest.NewRequest(tc.method, tc.path, body))
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertNoSecrets(t, rec.Body.String())
		})
	}
}

func TestAdminRouteMatrixInvalidJSONBranches(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, matrixServices())

	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{name: "account_patch", method: http.MethodPatch, path: "/v2/admin/accounts/a1", body: `{`},
		{name: "provider_create", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts", body: `{`},
		{name: "provider_batch", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/batch", body: `{`},
		{name: "provider_batch_patch", method: http.MethodPatch, path: "/v2/admin/providers/openai/accounts/batch", body: `{`},
		{name: "provider_batch_delete", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/batch-delete", body: `{`},
		{name: "provider_update", method: http.MethodPost, path: "/v2/admin/providers/openai/accounts/a1", body: `{`},
		{name: "quota_refresh", method: http.MethodPost, path: "/v2/admin/quota/refresh", body: `{`},
		{name: "keys_patch", method: http.MethodPatch, path: "/v2/admin/keys/k1", body: `{`},
		{name: "proxy_patch", method: http.MethodPatch, path: "/v2/admin/proxies/p1", body: `{`},
		{name: "proxy_search", method: http.MethodPost, path: "/v2/admin/proxies/search", body: `{`},
		{name: "proxy_import", method: http.MethodPost, path: "/v2/admin/proxies/import", body: `{`},
		{name: "proxy_scrape", method: http.MethodPost, path: "/v2/admin/proxies/scrape", body: `{`},
		{name: "proxy_settings", method: http.MethodPost, path: "/v2/admin/proxy-settings", body: `{`},
		{name: "backup_restore", method: http.MethodPost, path: "/v2/admin/backups/b1/restore", body: `{`},
		{name: "oauth_start", method: http.MethodPost, path: "/v2/admin/auth/oauth/start?providerId=openai", body: `{`},
		{name: "oauth_complete", method: http.MethodPost, path: "/v2/admin/auth/oauth/sessions/s1/complete", body: `{`},
		{name: "oauth_refresh", method: http.MethodPost, path: "/v2/admin/auth/oauth/refresh", body: `{`},
		{name: "oauth_reauth", method: http.MethodPost, path: "/v2/admin/auth/oauth/reauth", body: `{`},
		{name: "web_request", method: http.MethodPost, path: "/v2/admin/console/web-request", body: `{`},
		{name: "web_request_multi", method: http.MethodPost, path: "/v2/admin/console/web-request", body: `{}{}`},
		{name: "decode_extra", method: http.MethodPost, path: "/v2/admin/keys", body: `{"name":"ok"}{"extra":true}`},
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

func TestAdminRouteMatrixDecodeBoundedJSONHelpers(t *testing.T) {
	if err := decodeBoundedJSON(nil, &map[string]any{}, 10); err == nil {
		t.Fatal("expected nil request error")
	}
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Body = nil
	if err := decodeBoundedJSON(req, &map[string]any{}, 10); err == nil {
		t.Fatal("expected nil body error")
	}
	req2 := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
	if err := decodeBoundedJSON(req2, &map[string]any{}, 0); err == nil {
		t.Fatal("expected invalid limit")
	}
	req3 := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}{}`))
	if err := decodeBoundedJSON(req3, &map[string]any{}, 64); err == nil {
		t.Fatal("expected multi value error")
	}

	// handleOAuthSubroutes is currently unreachable via routing order; call it
	// directly so the redirect/unavailable contract stays covered.
	rec := httptest.NewRecorder()
	handleOAuthSubroutes(rec, httptest.NewRequest(http.MethodPost, "/v2/admin/providers/openai/accounts/oauth/start", nil), matrixAccounts{}, "openai", nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("oauth start redirect status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec2 := httptest.NewRecorder()
	handleOAuthSubroutes(rec2, httptest.NewRequest(http.MethodGet, "/v2/admin/providers/openai/accounts/oauth/start", nil), matrixAccounts{}, "openai", nil)
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("oauth start method status=%d body=%s", rec2.Code, rec2.Body.String())
	}
	rec3 := httptest.NewRecorder()
	handleOAuthSubroutes(rec3, httptest.NewRequest(http.MethodGet, "/v2/admin/providers/openai/accounts/oauth/other", nil), matrixAccounts{}, "openai", nil)
	if rec3.Code != http.StatusNotFound {
		t.Fatalf("oauth other status=%d body=%s", rec3.Code, rec3.Body.String())
	}

	ctrl := httptest.NewRequest(http.MethodGet, "/v2/admin/auth/oauth/sessions/placeholder", nil)
	ctrl.URL.Path = "/v2/admin/auth/oauth/sessions/" + string(rune(0x01))
	rec4 := httptest.NewRecorder()
	handleOAuthSession(rec4, withSession(ctrl), matrixAuthService{})
	if rec4.Code != http.StatusBadRequest {
		t.Fatalf("control char session status=%d body=%s", rec4.Code, rec4.Body.String())
	}
}

func TestAdminRouteMatrixOAuthHelpersAndReauth(t *testing.T) {
	if _, _, err := parseKiroCallback("https://evil.example/callback"); err == nil {
		t.Fatal("expected invalid callback")
	}
	if _, _, err := parseKiroCallback("kiro://kiro.kiroAgent/authenticate-success?error=access_denied"); err == nil {
		t.Fatal("expected provider denied")
	}
	if _, _, err := parseKiroCallback("kiro://kiro.kiroAgent/authenticate-success"); err == nil {
		t.Fatal("expected missing code/state")
	}
	code, state, err := parseKiroCallback("kiro://kiro.kiroAgent/authenticate-success?code=abc&state=xyz")
	if err != nil || code != "abc" || state != "xyz" {
		t.Fatalf("parse ok got code=%q state=%q err=%v", code, state, err)
	}

	if classifyOAuthError(nil) != nil {
		t.Fatal("nil classify")
	}
	adminErr := NewError(CodeInvalidRequest, "already admin")
	if classifyOAuthError(adminErr) != adminErr {
		t.Fatal("passthrough admin error")
	}
	if !strings.Contains(classifyOAuthError(errors.New("session expired")).Error(), "expired") {
		t.Fatal("expired mapping")
	}
	if classifyOAuthError(errors.New("state mismatch")).(*Error).Code != CodeInvalidRequest {
		t.Fatal("mismatch mapping")
	}
	if classifyOAuthError(errors.New("unsupported grant")).(*Error).Code != CodeUnavailable {
		t.Fatal("unsupported mapping")
	}
	if classifyOAuthError(errors.New("boom")).(*Error).Code != CodeUnavailable {
		t.Fatal("default mapping")
	}

	scopes := boundedScopes(append([]string{"", " a ", strings.Repeat("s", 300)}, make([]string, 40)...))
	if len(scopes) == 0 || len(scopes) > 32 {
		t.Fatalf("boundedScopes=%v", scopes)
	}
	if got := firstJSONString(map[string]any{"x": []any{"a", "b", 3}}, "x"); got != "a b" {
		t.Fatalf("firstJSONString array=%q", got)
	}
	if got := firstJSONString(map[string]any{"x": "  "}, "x"); got != "" {
		t.Fatalf("blank string should be empty, got %q", got)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if got := parseJSONExpiry(map[string]any{"expires_at": now.Format(time.RFC3339)}, now); !got.Equal(now) {
		t.Fatalf("parseJSONExpiry rfc=%v", got)
	}
	if got := parseJSONExpiry(map[string]any{}, now); !got.Equal(now.Add(time.Hour)) {
		t.Fatalf("parseJSONExpiry default=%v", got)
	}

	svc, err := NewOAuthService(mustRegistry(t), flow.NewManager(flow.ManagerOptions{}), accounts.NewMemoryAccountConfigStore(), accounts.NewMemorySecretStore(), accounts.NewMemoryRecordStore(), &fixtureRefresher{token: &accounts.TokenSet{Access: accounts.NewSecretFromString("a"), Refresh: accounts.NewSecretFromString("r"), ExpiresAt: time.Now().Add(time.Hour)}})
	if err != nil {
		t.Fatal(err)
	}
	stateOut, err := svc.OAuthReauthenticate(context.Background(), OAuthRefreshInput{AccountID: "acct-reauth"})
	if err != nil {
		t.Fatal(err)
	}
	if stateOut.AccountID != "acct-reauth" || stateOut.Status != "completed" {
		t.Fatalf("reauth=%#v", stateOut)
	}

	if _, err := (*OAuthService)(nil).OAuthStart(context.Background(), "x", OAuthStartInput{}); err == nil {
		t.Fatal("nil service start")
	}
	if _, err := svc.OAuthStart(context.Background(), "", OAuthStartInput{}); err == nil {
		t.Fatal("empty provider")
	}
	if _, err := svc.OAuthStart(context.Background(), "codex", OAuthStartInput{Flow: "weird"}); err == nil {
		t.Fatal("bad flow")
	}
	if _, err := svc.OAuthStart(context.Background(), "codex", OAuthStartInput{Mode: strings.Repeat("m", 100)}); err == nil {
		t.Fatal("mode too long")
	}
	if _, err := svc.OAuthStart(context.Background(), "openai", OAuthStartInput{Mode: "manual-json"}); err == nil {
		t.Fatal("manual json only kiro")
	}
	if _, err := svc.OAuthStart(context.Background(), "kiro", OAuthStartInput{Mode: "social", SocialProvider: "twitter"}); err == nil {
		t.Fatal("bad social")
	}
	if _, err := svc.OAuthComplete(context.Background(), "missing", OAuthCompleteInput{Code: "x"}); err == nil {
		t.Fatal("missing session")
	}
	if err := svc.OAuthCancel(context.Background(), "missing"); err == nil {
		t.Fatal("cancel missing")
	}
	if _, err := (*OAuthService)(nil).OAuthRefresh(context.Background(), OAuthRefreshInput{AccountID: "a"}); err == nil {
		t.Fatal("nil refresh")
	}
	if _, err := svc.OAuthRefresh(context.Background(), OAuthRefreshInput{}); err == nil {
		t.Fatal("refresh missing account")
	}
	if _, err := NewOAuthService(nil, nil, nil, nil, nil, nil); err == nil {
		t.Fatal("expected NewOAuthService error")
	}

	long := strings.Repeat("u", 300)
	writeOAuthState(httptest.NewRecorder(), OAuthState{
		SessionID: long, AccountID: long, Status: long, Flow: long, URL: long,
		State: long, UserCode: long, VerificationURI: long, ExpiresAt: long, IntervalSeconds: 99999,
	})
}

func TestAdminRouteMatrixCatalogAndBackupArtifactEdges(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, Services{
		Dashboard:  testDashboard{},
		Authorizer: matrixAuthorizer{},
		Catalog: catalogTestService{
			providerErr: errors.New("authorization Bearer " + matrixSecretMarker),
			modelErr:    NewError(CodeNotFound, "missing model"),
		},
		Backup: matrixBackup{},
	})

	req := withSession(httptest.NewRequest(http.MethodGet, "/v2/admin/catalog/providers", nil))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("catalog providers status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertNoSecrets(t, rec.Body.String())

	req2 := withSession(httptest.NewRequest(http.MethodGet, "/v2/admin/catalog/models", nil))
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("catalog models status=%d body=%s", rec2.Code, rec2.Body.String())
	}

	writeBackupArtifact(httptest.NewRecorder(), BackupArtifact{Content: []byte("x")})
	writeBackupArtifact(httptest.NewRecorder(), BackupArtifact{MIMEType: "text/plain", Filename: "a.bin", Content: nil})
}
