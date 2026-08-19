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
func (failingAccounts) Quota(context.Context, string) (QuotaState, error) {
	return QuotaState{}, NewError(CodeUnavailable, "quota failed")
}
func (failingAccounts) RevokeForProvider(context.Context, string, string) error {
	return NewError(CodeUnavailable, "provider revoke failed")
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
func (failingAuthNoStatus) Refresh(context.Context, string, AuthRequest) (LoginResult, error) {
	return LoginResult{}, NewError(CodeUnavailable, "refresh failed")
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
		{name: "account_get_method", method: http.MethodGet, path: "/console/accounts/acct-1", want: http.StatusMethodNotAllowed},
		{name: "account_quota_put", method: http.MethodPut, path: "/console/accounts/acct-1/quota", want: http.StatusMethodNotAllowed},
		{name: "account_removed_revoke_get", method: http.MethodGet, path: "/console/accounts/acct-1/revoke", want: http.StatusNotFound},
		{name: "account_removed_oauth_post", method: http.MethodPost, path: "/console/accounts/acct-1/oauth-status", want: http.StatusNotFound},
		{name: "account_empty_id", method: http.MethodDelete, path: "/console/accounts/", want: http.StatusNotFound},
		{name: "provider_put", method: http.MethodPut, path: "/console/providers/openai/accounts", want: http.StatusMethodNotAllowed},
		{name: "provider_batch_get", method: http.MethodGet, path: "/console/providers/openai/accounts/batch", want: http.StatusMethodNotAllowed},
		{name: "provider_batch_delete_get", method: http.MethodGet, path: "/console/providers/openai/accounts/batch-delete", want: http.StatusMethodNotAllowed},
		{name: "provider_account_get", method: http.MethodGet, path: "/console/providers/openai/accounts/acct-1", want: http.StatusMethodNotAllowed},
		{name: "provider_revoke_get", method: http.MethodGet, path: "/console/providers/openai/accounts/acct-1/revoke", want: http.StatusMethodNotAllowed},
		{name: "provider_missing_accounts", method: http.MethodGet, path: "/console/providers/openai/other", want: http.StatusNotFound},
		{name: "provider_oauth_as_account_post", method: http.MethodPost, path: "/console/providers/openai/accounts/oauth", body: `{"label":"x"}`, want: http.StatusOK},
		{name: "provider_oauth_as_account_get", method: http.MethodGet, path: "/console/providers/openai/accounts/oauth", want: http.StatusMethodNotAllowed},
		{name: "oauth_session_empty", method: http.MethodGet, path: "/console/auth/oauth/sessions/", want: http.StatusNotFound},
		{name: "oauth_session_unknown", method: http.MethodGet, path: "/console/auth/oauth/sessions/s1/weird", want: http.StatusNotFound},
		{name: "oauth_status_post", method: http.MethodPost, path: "/console/auth/oauth/sessions/s1/status", want: http.StatusMethodNotAllowed},
		{name: "oauth_complete_get", method: http.MethodGet, path: "/console/auth/oauth/sessions/s1/complete", want: http.StatusMethodNotAllowed},
		{name: "oauth_cancel_get", method: http.MethodGet, path: "/console/auth/oauth/sessions/s1/cancel", want: http.StatusMethodNotAllowed},
		{name: "oauth_session_too_long", method: http.MethodGet, path: "/console/auth/oauth/sessions/" + strings.Repeat("s", 300), want: http.StatusBadRequest},
		{name: "oauth_bare_session", method: http.MethodGet, path: "/console/auth/oauth/sessions/s1", want: http.StatusOK},
		{name: "auth_login_wrong_method", method: http.MethodGet, path: "/console/auth/login", want: http.StatusUnauthorized},
		{name: "match_method_fold", method: http.MethodGet, path: "/console/accounts", want: http.StatusOK},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var body io.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			}
			req := httptest.NewRequest(tc.method, tc.path, body)
			if tc.path != "/console/auth/login" {
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
	svc.Settings = failingSettings{}
	svc.ConsoleLogs = failingConsoleLogs{}
	svc.Auth = failingAuthNoStatus{}
	svc.OAuth = failingAuthNoStatus{}

	mux := http.NewServeMux()
	Register(mux, svc)

	cases := []struct {
		name   string
		method string
		path   string
		body   string
		want   int
	}{
		{name: "accounts_list", method: http.MethodGet, path: "/console/accounts", want: http.StatusServiceUnavailable},
		{name: "accounts_patch", method: http.MethodPatch, path: "/console/accounts/a1", body: `{"name":"x"}`, want: http.StatusServiceUnavailable},
		{name: "accounts_delete", method: http.MethodDelete, path: "/console/accounts/a1", want: http.StatusServiceUnavailable},
		{name: "accounts_quota", method: http.MethodGet, path: "/console/accounts/a1/quota", want: http.StatusServiceUnavailable},
		{name: "accounts_quota_post", method: http.MethodPost, path: "/console/accounts/a1/quota", want: http.StatusServiceUnavailable},
		{name: "provider_list", method: http.MethodGet, path: "/console/providers/openai/accounts", want: http.StatusServiceUnavailable},
		{name: "provider_create", method: http.MethodPost, path: "/console/providers/openai/accounts", body: `{"label":"x"}`, want: http.StatusServiceUnavailable},
		{name: "provider_batch", method: http.MethodPost, path: "/console/providers/openai/accounts/batch", body: `{"items":[{"label":"x"}]}`, want: http.StatusServiceUnavailable},
		{name: "provider_batch_patch", method: http.MethodPatch, path: "/console/providers/openai/accounts/batch", body: `{"items":[{"accountId":"a1"}]}`, want: http.StatusServiceUnavailable},
		{name: "provider_batch_delete", method: http.MethodPost, path: "/console/providers/openai/accounts/batch-delete", body: `{"items":["a1"]}`, want: http.StatusServiceUnavailable},
		{name: "provider_update", method: http.MethodPost, path: "/console/providers/openai/accounts/a1", body: `{"name":"x"}`, want: http.StatusServiceUnavailable},
		{name: "provider_delete", method: http.MethodDelete, path: "/console/providers/openai/accounts/a1", want: http.StatusServiceUnavailable},
		{name: "provider_revoke", method: http.MethodPost, path: "/console/providers/openai/accounts/a1/revoke", want: http.StatusServiceUnavailable},
		{name: "settings_get", method: http.MethodGet, path: "/console/settings", want: http.StatusServiceUnavailable},
		{name: "settings_patch", method: http.MethodPatch, path: "/console/settings", body: `{"logLevel":"info"}`, want: http.StatusServiceUnavailable},
		{name: "settings_reset", method: http.MethodPost, path: "/console/settings", want: http.StatusServiceUnavailable},
		{name: "console_logs", method: http.MethodGet, path: "/console/logs", want: http.StatusServiceUnavailable},
		{name: "auth_logout", method: http.MethodPost, path: "/console/auth/logout", want: http.StatusServiceUnavailable},
		{name: "auth_session", method: http.MethodGet, path: "/console/auth/session", want: http.StatusServiceUnavailable},
		{name: "auth_refresh", method: http.MethodPost, path: "/console/auth/refresh", want: http.StatusServiceUnavailable},
		{name: "oauth_start", method: http.MethodPost, path: "/console/auth/oauth/start?providerId=openai", body: `{}`, want: http.StatusServiceUnavailable},
		{name: "oauth_status", method: http.MethodGet, path: "/console/auth/oauth/sessions/s1/status", want: http.StatusServiceUnavailable},
		{name: "oauth_complete", method: http.MethodPost, path: "/console/auth/oauth/sessions/s1/complete", body: `{"code":"c","state":"s"}`, want: http.StatusServiceUnavailable},
		{name: "oauth_cancel", method: http.MethodPost, path: "/console/auth/oauth/sessions/s1/cancel", want: http.StatusServiceUnavailable},
		{name: "oauth_refresh", method: http.MethodPost, path: "/console/auth/oauth/refresh", body: `{"accountId":"a1"}`, want: http.StatusServiceUnavailable},
		{name: "oauth_reauth", method: http.MethodPost, path: "/console/auth/oauth/reauth", body: `{"accountId":"a1"}`, want: http.StatusServiceUnavailable},
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
		{name: "account_patch", method: http.MethodPatch, path: "/console/accounts/a1", body: `{`},
		{name: "provider_create", method: http.MethodPost, path: "/console/providers/openai/accounts", body: `{`},
		{name: "provider_batch", method: http.MethodPost, path: "/console/providers/openai/accounts/batch", body: `{`},
		{name: "provider_batch_patch", method: http.MethodPatch, path: "/console/providers/openai/accounts/batch", body: `{`},
		{name: "provider_batch_delete", method: http.MethodPost, path: "/console/providers/openai/accounts/batch-delete", body: `{`},
		{name: "provider_update", method: http.MethodPost, path: "/console/providers/openai/accounts/a1", body: `{`},
		{name: "oauth_start", method: http.MethodPost, path: "/console/auth/oauth/start?providerId=openai", body: `{`},
		{name: "oauth_complete", method: http.MethodPost, path: "/console/auth/oauth/sessions/s1/complete", body: `{`},
		{name: "oauth_refresh", method: http.MethodPost, path: "/console/auth/oauth/refresh", body: `{`},
		{name: "oauth_reauth", method: http.MethodPost, path: "/console/auth/oauth/reauth", body: `{`},
		{name: "settings_patch", method: http.MethodPatch, path: "/console/settings", body: `{`},
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

func TestAdminRouteMatrixOAuthSessionHelpers(t *testing.T) {
	ctrl := httptest.NewRequest(http.MethodGet, "/console/auth/oauth/sessions/placeholder", nil)
	ctrl.URL.Path = "/console/auth/oauth/sessions/" + string(rune(0x01))
	rec4 := httptest.NewRecorder()
	handleOAuthSession(rec4, withSession(ctrl), matrixAuthService{})
	if rec4.Code != http.StatusBadRequest {
		t.Fatalf("control char session status=%d body=%s", rec4.Code, rec4.Body.String())
	}
}

func TestAdminRouteMatrixGenerationPublishFailure(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, Services{
		Settings:   testSettings{},
		Authorizer: matrixAuthorizer{},
		Generation: failingGeneration{},
	})
	req := withSession(httptest.NewRequest(http.MethodPatch, "/console/settings", strings.NewReader(`{"logLevel":"info"}`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("generation publish failure status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertNoSecrets(t, rec.Body.String())
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

func TestAdminRouteMatrixCatalogErrorEdges(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, Services{
		Dashboard:  testDashboard{},
		Authorizer: matrixAuthorizer{},
		Catalog: catalogTestService{
			providerErr: errors.New("authorization Bearer " + matrixSecretMarker),
		},
	})

	req := withSession(httptest.NewRequest(http.MethodGet, "/console/catalog/providers", nil))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("catalog providers status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertNoSecrets(t, rec.Body.String())
}
