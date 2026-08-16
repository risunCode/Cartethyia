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
func (matrixAccounts) Quota(_ context.Context, accountID string) (QuotaState, error) {
	return QuotaState{AccountID: accountID, Used: 1, Limit: 10, Remaining: 9}, nil
}
func (matrixAccounts) RevokeForProvider(context.Context, string, string) error { return nil }

func matrixServices() Services {
	return Services{
		Dashboard:   testDashboard{},
		Accounts:    matrixAccounts{},
		Settings:    testSettings{},
		Auth:        matrixAuthService{},
		Telemetry:   &routeTelemetry{},
		ConsoleLogs: routeConsoleLogs{},
		Usage:       routeUsage{},
		Catalog:     catalogTestService{},
		Authorizer:  matrixAuthorizer{},
		Audit:       &testAudit{},
		Generation:  &testGeneration{},
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
	req.AddCookie(&http.Cookie{Name: "cartethyia_session", Value: "session-matrix"})
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
		{group: "auth", method: http.MethodPost, path: "/console/auth/login", body: `{"username":"op","password":"x"}`, want: http.StatusOK},
		{group: "auth", method: http.MethodGet, path: "/console/auth/session", want: http.StatusOK},
		{group: "accounts", method: http.MethodGet, path: "/console/accounts", want: http.StatusOK},
		{group: "accounts", method: http.MethodGet, path: "/console/providers/openai/accounts", want: http.StatusOK},
		{group: "catalog", method: http.MethodGet, path: "/console/catalog/providers", want: http.StatusOK},
		{group: "settings", method: http.MethodGet, path: "/console/settings", want: http.StatusOK},
		{group: "telemetry", method: http.MethodGet, path: "/console/telemetry/overview", want: http.StatusOK},
		{group: "console", method: http.MethodGet, path: "/console/logs", want: http.StatusOK},
		{group: "dashboard", method: http.MethodGet, path: "/console/dashboard", want: http.StatusOK},
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
			if tc.path != "/console/auth/login" {
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
		{group: "auth", method: http.MethodGet, path: "/console/auth/session", want: http.StatusUnauthorized},
		{group: "accounts", method: http.MethodGet, path: "/console/accounts", want: http.StatusUnauthorized},
		{group: "accounts", method: http.MethodGet, path: "/console/providers/openai/accounts", want: http.StatusUnauthorized},
		{group: "catalog", method: http.MethodGet, path: "/console/catalog/providers", want: http.StatusUnauthorized},
		{group: "settings", method: http.MethodGet, path: "/console/settings", want: http.StatusUnauthorized},
		{group: "telemetry", method: http.MethodGet, path: "/console/telemetry/overview", want: http.StatusUnauthorized},
		{group: "console", method: http.MethodGet, path: "/console/logs", want: http.StatusUnauthorized},
		{group: "dashboard", method: http.MethodGet, path: "/console/dashboard", want: http.StatusUnauthorized},
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
		{name: "settings_log_level", method: http.MethodPatch, path: "/console/settings", body: `{"logLevel":"verbose"}`},
		{name: "account_label_too_long", method: http.MethodPost, path: "/console/providers/openai/accounts", body: `{"label":"` + strings.Repeat("a", 300) + `"}`},
		{name: "oauth_refresh_missing_account", method: http.MethodPost, path: "/console/auth/oauth/refresh", body: `{"accountId":""}`},
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
		// Catalog stays registered and returns unavailable.
	})

	cases := []struct {
		path string
	}{
		{"/console/catalog/providers"},
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
		{name: "auth_logout", method: http.MethodPost, path: "/console/auth/logout", want: http.StatusOK},
		{name: "auth_refresh", method: http.MethodPost, path: "/console/auth/refresh", want: http.StatusOK},
		{name: "oauth_start", method: http.MethodPost, path: "/console/auth/oauth/start?providerId=openai", body: `{"flow":"browser"}`, want: http.StatusOK},
		{name: "oauth_status", method: http.MethodGet, path: "/console/auth/oauth/sessions/oauth-session/status", want: http.StatusOK},
		{name: "oauth_complete", method: http.MethodPost, path: "/console/auth/oauth/sessions/oauth-session/complete", body: `{"code":"abc","state":"st"}`, want: http.StatusOK},
		{name: "oauth_cancel", method: http.MethodPost, path: "/console/auth/oauth/sessions/oauth-session/cancel", want: http.StatusOK},
		{name: "oauth_refresh", method: http.MethodPost, path: "/console/auth/oauth/refresh", body: `{"accountId":"acct-1","force":true}`, want: http.StatusOK},
		{name: "oauth_reauth", method: http.MethodPost, path: "/console/auth/oauth/reauth", body: `{"accountId":"acct-1"}`, want: http.StatusOK},
		{name: "account_patch", method: http.MethodPatch, path: "/console/accounts/acct-1", body: `{"name":"renamed"}`, want: http.StatusOK},
		{name: "account_delete", method: http.MethodDelete, path: "/console/accounts/acct-2", want: http.StatusNoContent},
		{name: "account_quota_get", method: http.MethodGet, path: "/console/accounts/acct-1/quota", want: http.StatusOK},
		{name: "account_quota_refresh", method: http.MethodPost, path: "/console/accounts/acct-1/quota", want: http.StatusOK},
		{name: "provider_create", method: http.MethodPost, path: "/console/providers/openai/accounts", body: `{"name":"n1","label":"l1"}`, want: http.StatusCreated},
		{name: "provider_batch_create", method: http.MethodPost, path: "/console/providers/openai/accounts/batch", body: `{"items":[{"label":"a"}]}`, want: http.StatusCreated},
		{name: "provider_batch_update", method: http.MethodPatch, path: "/console/providers/openai/accounts/batch", body: `{"items":[{"accountId":"acct-1"}]}`, want: http.StatusOK},
		{name: "provider_batch_delete", method: http.MethodPost, path: "/console/providers/openai/accounts/batch-delete", body: `{"items":["acct-1"]}`, want: http.StatusOK},
		{name: "provider_update", method: http.MethodPost, path: "/console/providers/openai/accounts/acct-1", body: `{"name":"n2"}`, want: http.StatusOK},
		{name: "provider_delete", method: http.MethodDelete, path: "/console/providers/openai/accounts/acct-9", want: http.StatusNoContent},
		{name: "provider_revoke", method: http.MethodPost, path: "/console/providers/openai/accounts/acct-1/revoke", want: http.StatusOK},
		{name: "settings_reset_post", method: http.MethodPost, path: "/console/settings", want: http.StatusOK},
		{name: "telemetry_requests", method: http.MethodGet, path: "/console/telemetry/requests?period=1h&bucket=5m&limit=10&group_by=provider", want: http.StatusOK},
		{name: "telemetry_errors", method: http.MethodGet, path: "/console/telemetry/errors", want: http.StatusOK},
		{name: "telemetry_upstream", method: http.MethodGet, path: "/console/telemetry/upstream", want: http.StatusOK},
		{name: "telemetry_usage", method: http.MethodGet, path: "/console/telemetry/usage", want: http.StatusOK},
		{name: "telemetry_clients", method: http.MethodGet, path: "/console/telemetry/clients", want: http.StatusOK},
		{name: "method_not_allowed_accounts", method: http.MethodPut, path: "/console/accounts", want: http.StatusBadRequest},
		{name: "method_not_allowed_dashboard", method: http.MethodPost, path: "/console/dashboard", want: http.StatusBadRequest},
		{name: "account_unknown_sub", method: http.MethodGet, path: "/console/accounts/acct-1/unknown", want: http.StatusNotFound},
		{name: "provider_oauth_start_removed", method: http.MethodPost, path: "/console/providers/openai/accounts/oauth/start", want: http.StatusNotFound},
		{name: "oauth_start_missing_provider", method: http.MethodPost, path: "/console/auth/oauth/start", body: `{}`, want: http.StatusBadRequest},
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

	okReq := withSession(httptest.NewRequest(http.MethodGet, "/console/dashboard", nil))
	okRec := httptest.NewRecorder()
	mux.ServeHTTP(okRec, okReq)
	if okRec.Code != http.StatusOK {
		t.Fatalf("health scope status=%d body=%s", okRec.Code, okRec.Body.String())
	}

	denied := withSession(httptest.NewRequest(http.MethodGet, "/console/settings", nil))
	deniedRec := httptest.NewRecorder()
	mux.ServeHTTP(deniedRec, denied)
	if deniedRec.Code != http.StatusForbidden {
		t.Fatalf("denied status=%d body=%s", deniedRec.Code, deniedRec.Body.String())
	}
	assertNoSecrets(t, deniedRec.Body.String())

	// Mutation denied should still audit without secrets.
	mut := withSession(httptest.NewRequest(http.MethodPatch, "/console/settings", strings.NewReader(`{"logLevel":"info"}`)))
	mut.Header.Set("Content-Type", "application/json")
	mutRec := httptest.NewRecorder()
	mux.ServeHTTP(mutRec, mut)
	if mutRec.Code != http.StatusForbidden {
		t.Fatalf("mutation denied status=%d", mutRec.Code)
	}
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
	listen := "not-a-listen-addr"
	if err := validateAdminPayload(&RuntimeSettingsInput{ListenAddr: &listen}); err == nil {
		t.Fatal("expected listen addr validation error")
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
	if hasScope([]string{"admin:accounts"}, ScopeConfig) {
		t.Fatal("hasScope should deny mismatched scope")
	}
	if boundedAuditField(strings.Repeat("z", 300)) != strings.Repeat("z", 256) {
		t.Fatal("boundedAuditField truncate")
	}

	req := httptest.NewRequest(http.MethodGet, "http://example.test/console/dashboard?sessionId=from-query", nil)
	req.Header.Set("X-Real-IP", "198.51.100.7")
	if got := readSessionID(req); got != "" {
		t.Fatalf("readSessionID must ignore query transport, got %q", got)
	}
	req.Header.Set("X-Session-Id", "from-header")
	if got := readSessionID(req); got != "" {
		t.Fatalf("readSessionID must ignore header transport, got %q", got)
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

	if adminScopeForPath("/console/auth/login") != ScopeAuth {
		t.Fatal("scope auth")
	}
	if adminScopeForPath("/console/accounts/x") != ScopeAccounts {
		t.Fatal("scope accounts")
	}
	if generationScope("/console/settings") != "configuration" {
		t.Fatal("generation configuration")
	}
	if generationScope("/console/dashboard") != "lifecycle" {
		t.Fatal("generation lifecycle default")
	}
	if !isGenerationMutation("/console/settings", http.MethodPatch) {
		t.Fatal("settings generation mutation")
	}
	if isGenerationMutation("/console/dashboard", http.MethodGet) {
		t.Fatal("get should not mutate generation")
	}
}

func TestAdminRouteMatrixNilServiceRegistrationIsAbsent(t *testing.T) {
	mux := http.NewServeMux()
	RegisterAccounts(mux, Services{})
	RegisterSettings(mux, Services{})
	RegisterAuth(mux, Services{})
	RegisterTelemetry(mux, Services{})
	RegisterConsole(mux, Services{})
	RegisterUsage(mux, Services{})

	req := httptest.NewRequest(http.MethodGet, "/console/accounts", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("nil accounts should leave route unregistered, got %d", rec.Code)
	}
}

func TestAdminRouteMatrixDecodeJSONErrors(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, matrixServices())
	req := withSession(httptest.NewRequest(http.MethodPatch, "/console/settings", strings.NewReader(`{"logLevel":`)))
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
	req := httptest.NewRequest(http.MethodPost, "/console/auth/login", strings.NewReader(`{}`))
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
