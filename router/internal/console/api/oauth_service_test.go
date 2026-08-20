package api

import (

	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	accounts "github.com/cartethyia/daemon/internal/accounts/auth"
)

type responseBodyTransport struct {
	mu       sync.Mutex
	requests int
	respond  func(int, *http.Request) (int, []byte)
}

func (t *responseBodyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	t.requests++
	index := t.requests
	t.mu.Unlock()
	status, body := t.respond(index, req)
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: ioNopCloser{strings.NewReader(string(body))}, Request: req, ContentLength: int64(len(body))}, nil
}

type ioNopCloser struct{ *strings.Reader }

func (ioNopCloser) Close() error { return nil }

func TestOAuthServiceBrowserCompletionPersistsRedactedAccount(t *testing.T) {
	transport := &responseBodyTransport{respond: func(_ int, req *http.Request) (int, []byte) {
		if req.URL.Path != "/oauth/token" {
			return http.StatusNotFound, []byte(`{"error":"not_found"}`)
		}
		return http.StatusOK, []byte(`{"access_token":"access-secret","refresh_token":"refresh-secret","expires_in":3600,"account_id":"provider-account","email":"operator@example.test"}`)
	}}
	registry, err := accounts.NewRegistry(map[string]accounts.Config{"codex": {HTTPClient: &http.Client{Transport: transport}}})
	if err != nil {
		t.Fatal(err)
	}
	accountsStore, secrets, records := accounts.NewMemoryAccountConfigStore(), accounts.NewMemorySecretStore(), accounts.NewMemoryRecordStore()
	service, err := NewOAuthService(registry, accounts.NewManager(accounts.ManagerOptions{}), accountsStore, secrets, records, nil)
	if err != nil {
		t.Fatal(err)
	}
	started, err := service.OAuthStart(context.Background(), "codex", OAuthStartInput{Flow: "browser", RedirectURI: "http://127.0.0.1/callback"})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(started.URL)
	if err != nil {
		t.Fatal(err)
	}
	state := parsed.Query().Get("state")
	if state == "" || started.State != "" {
		t.Fatalf("state leaked or missing: state=%q public=%q", state, started.State)
	}
	completed, err := service.OAuthComplete(context.Background(), started.SessionID, OAuthCompleteInput{Code: "http://127.0.0.1/callback?code=fixture-code&state=" + url.QueryEscape(state)})
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != "completed" || completed.AccountID == "" {
		t.Fatalf("completion = %#v", completed)
	}
	stored, err := accountsStore.Get(context.Background(), completed.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ProviderID != "codex" || stored.Kind != accounts.KindOAuth {
		t.Fatalf("stored config = %#v", stored)
	}
	access, err := secrets.GetAccess(context.Background(), completed.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	if access.RevealString() != "access-secret" {
		t.Fatal("access secret was not persisted")
	}
	access.Close()
	encoded := mustJSON(t, completed)
	if strings.Contains(encoded, "access-secret") || strings.Contains(encoded, "refresh-secret") {
		t.Fatal("OAuth state leaked token material")
	}
}

func TestOAuthServiceKiroAWSDevicePendingThenCompleted(t *testing.T) {
	transport := &responseBodyTransport{respond: func(index int, req *http.Request) (int, []byte) {
		switch req.URL.Path {
		case "/client/register":
			return http.StatusOK, []byte(`{"clientId":"fixture-client","clientSecret":"fixture-secret"}`)
		case "/device_authorization":
			return http.StatusOK, []byte(`{"deviceCode":"device-secret","userCode":"ABCD-EFGH","verificationUri":"https://device.example.test","expiresIn":900,"interval":1}`)
		case "/token":
			if index < 4 {
				return http.StatusBadRequest, []byte(`{"error":"authorization_pending"}`)
			}
			return http.StatusOK, []byte(`{"accessToken":"aws-access","refreshToken":"aws-refresh","expiresIn":3600,"profileArn":"arn:aws:iam::123:role/Kiro"}`)
		default:
			return http.StatusNotFound, []byte(`{"error":"not_found"}`)
		}
	}}
	registry, err := accounts.NewRegistry(map[string]accounts.Config{"kiro": {HTTPClient: &http.Client{Transport: transport}}})
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewOAuthService(registry, accounts.NewManager(accounts.ManagerOptions{TTL: time.Minute}), accounts.NewMemoryAccountConfigStore(), accounts.NewMemorySecretStore(), accounts.NewMemoryRecordStore(), nil)
	if err != nil {
		t.Fatal(err)
	}
	started, err := service.OAuthStart(context.Background(), "kiro", OAuthStartInput{Flow: "device"})
	if err != nil {
		t.Fatalf("start error=%T %v cause=%#v", err, err, errors.Unwrap(err))
	}
	if started.UserCode != "ABCD-EFGH" || started.VerificationURI == "" {
		t.Fatalf("device start = %#v", started)
	}
	pending, err := service.OAuthStatus(context.Background(), started.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if pending.Status != "pending" {
		t.Fatalf("pending status = %#v", pending)
	}
	completed, err := service.OAuthStatus(context.Background(), started.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != "completed" || completed.AccountID == "" {
		t.Fatalf("completed status = %#v", completed)
	}
}

func TestOAuthServiceKiroManualJSONImportIsRedacted(t *testing.T) {
	service, err := NewOAuthService(mustRegistry(t), accounts.NewManager(accounts.ManagerOptions{}), accounts.NewMemoryAccountConfigStore(), accounts.NewMemorySecretStore(), accounts.NewMemoryRecordStore(), nil)
	if err != nil {
		t.Fatal(err)
	}
	state, err := service.OAuthStart(context.Background(), "kiro", OAuthStartInput{Mode: "manual-json", CredentialJSON: `{"access_token":"manual-access","refresh_token":"manual-refresh","expires_in":3600,"email":"manual@example.test"}`})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != "completed" || state.AccountID == "" {
		t.Fatalf("import state = %#v", state)
	}
	encoded := mustJSON(t, state)
	if strings.Contains(encoded, "manual-access") || strings.Contains(encoded, "manual-refresh") {
		t.Fatal("manual import leaked token material")
	}
}

func TestOAuthServiceKiroSocialModesBindProviderAndPKCE(t *testing.T) {
	service, err := NewOAuthService(mustRegistry(t), accounts.NewManager(accounts.ManagerOptions{}), accounts.NewMemoryAccountConfigStore(), accounts.NewMemorySecretStore(), accounts.NewMemoryRecordStore(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, provider := range []string{"google", "github"} {
		state, startErr := service.OAuthStart(context.Background(), "kiro", OAuthStartInput{Mode: "social", SocialProvider: provider})
		if startErr != nil {
			t.Fatal(startErr)
		}
		if state.SessionID == "" || !strings.Contains(state.URL, "code_challenge_method=S256") || strings.Contains(state.URL, "client_secret") {
			t.Fatalf("social %s state = %#v", provider, state)
		}
		if cancelErr := service.OAuthCancel(context.Background(), state.SessionID); cancelErr != nil {
			t.Fatal(cancelErr)
		}
	}
}

func TestOAuthServiceRefreshReturnsRedactedAccountState(t *testing.T) {
	refresher := &fixtureRefresher{token: &accounts.TokenSet{Access: accounts.NewSecretFromString("refreshed-access"), Refresh: accounts.NewSecretFromString("refreshed-refresh"), ExpiresAt: time.Now().Add(time.Hour)}}
	service, err := NewOAuthService(mustRegistry(t), accounts.NewManager(accounts.ManagerOptions{}), accounts.NewMemoryAccountConfigStore(), accounts.NewMemorySecretStore(), accounts.NewMemoryRecordStore(), refresher)
	if err != nil {
		t.Fatal(err)
	}
	state, err := service.OAuthRefresh(context.Background(), OAuthRefreshInput{AccountID: "account-fixture", Force: true})
	if err != nil {
		t.Fatal(err)
	}
	if state.AccountID != "account-fixture" || state.Status != "completed" {
		t.Fatalf("refresh state = %#v", state)
	}
	if strings.Contains(mustJSON(t, state), "refreshed-") {
		t.Fatal("refresh state leaked token material")
	}
}

type fixtureRefresher struct{ token *accounts.TokenSet }

func (r *fixtureRefresher) Current(_ context.Context, _ string) (*accounts.TokenSet, error) {
	return r.token.Clone(), nil
}
func (r *fixtureRefresher) ForceRefresh(_ context.Context, _ string) (*accounts.TokenSet, error) {
	return r.token.Clone(), nil
}
func (r *fixtureRefresher) Invalidate(_ string) {}
func mustRegistry(t *testing.T) *accounts.Registry {
	t.Helper()
	registry, err := accounts.NewRegistry(nil)
	if err != nil {
		t.Fatal(err)
	}
	return registry
}
func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
