package drivers

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
)

type fixtureTransport struct {
	calls   int
	pending bool
}

func (t *fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	t.calls++
	body, _ := io.ReadAll(r.Body)
	text := string(body)
	status, payload := 200, `{"access_token":"access-1","refresh_token":"refresh-1","expires_in":3600,"account_id":"acct-1","email":"user@example.test"}`
	if r.URL.Path == "/device" {
		payload = `{"device_code":"device-1","user_code":"ABCD","verification_uri":"https://oauth.test/verify","expires_in":900,"interval":2}`
	}
	if strings.Contains(text, "device_code") && t.pending {
		status, payload = 400, `{"error":"authorization_pending"}`
		t.pending = false
	}
	if strings.Contains(text, "refresh_token") {
		payload = `{"access_token":"access-2","expires_in":3600}`
	}
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(payload)), Request: r}, nil
}

func fixtureConfig(id string, caps accounts.Capabilities, tr *fixtureTransport) Config {
	return Config{ProviderID: id, Capabilities: caps, ClientID: "client", RedirectURI: "http://127.0.0.1/callback", Endpoints: Endpoints{Authorize: "https://oauth.test/authorize", Device: "https://oauth.test/device", Token: "https://oauth.test/token", Refresh: "https://oauth.test/token"}, HTTPClient: &http.Client{Transport: tr}, DisableIdentityEnrichment: true, Now: func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }}
}

func TestBrowserPKCEAndRotatedRefreshFallback(t *testing.T) {
	tr := &fixtureTransport{}
	d, err := New(fixtureConfig("claude", accounts.Capabilities{Browser: true, Exchange: true, Refresh: true}, tr))
	if err != nil {
		t.Fatal(err)
	}
	start, err := d.Start(context.Background(), accounts.OAuthStartInput{Flow: accounts.FlowBrowser})
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(start.AuthorizationURL)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256([]byte(start.CodeVerifier))
	want := base64.RawURLEncoding.EncodeToString(h[:])
	if u.Query().Get("code_challenge") != want || u.Query().Get("code_challenge_method") != "S256" {
		t.Fatalf("invalid PKCE query: %s", u.RawQuery)
	}
	ts, err := d.Exchange(context.Background(), accounts.OAuthExchangeInput{Code: "auth-code", State: start.State})
	if err != nil {
		t.Fatal(err)
	}
	if ts.Email != "user@example.test" || ts.Refresh == nil {
		t.Fatalf("exchange metadata = %#v", ts)
	}
	old := ts.Refresh.RevealString()
	ts2, err := d.Refresh(context.Background(), accounts.RefreshTokenInput{AccountID: "acct", RefreshToken: ts.Refresh})
	if err != nil {
		t.Fatal(err)
	}
	if ts2.Refresh == nil || ts2.Refresh.RevealString() != old {
		t.Fatal("rotated refresh omission was not preserved")
	}
	ts.Close()
	ts2.Close()
}

func TestDevicePendingThenCompleteAndAccessOnlyReauth(t *testing.T) {
	tr := &fixtureTransport{pending: true}
	d, err := New(fixtureConfig("codex", accounts.Capabilities{Device: true, Poll: true, Refresh: true}, tr))
	if err != nil {
		t.Fatal(err)
	}
	start, err := d.Start(context.Background(), accounts.OAuthStartInput{Flow: accounts.FlowDevice})
	if err != nil {
		t.Fatal(err)
	}
	pending, err := d.Poll(context.Background(), start.State)
	if err != nil || pending.Status != accounts.PollPending {
		t.Fatalf("pending = %#v %v", pending, err)
	}
	complete, err := d.Poll(context.Background(), start.State)
	if err != nil || complete.Status != accounts.PollCompleted || complete.TokenSet == nil {
		t.Fatalf("complete = %#v %v", complete, err)
	}
	complete.TokenSet.Close()
	kimchi, err := New(fixtureConfig("kimchi", accounts.Capabilities{Browser: true, Exchange: true, AccessOnly: true}, tr))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := kimchi.Refresh(context.Background(), accounts.RefreshTokenInput{AccountID: "acct", RefreshToken: accounts.NewSecretFromString("refresh")}); accounts.Classify(err) != accounts.ErrKindReauthentication {
		t.Fatalf("access-only refresh = %v", err)
	}
}

func TestRegistryCanonicalIDsAndExclusions(t *testing.T) {
	r, err := NewRegistry(nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := r.IDs(); len(got) != 8 {
		t.Fatalf("ids = %#v", got)
	}
	if r.Has("devin") || r.Has("cursor") || r.Has("cursorcli") {
		t.Fatal("excluded driver registered")
	}
	if d, ok := r.Get("grok"); !ok || d.(accounts.DriverInfo).ID() != "grok-build" {
		t.Fatalf("grok normalization failed: %#v %v", d, ok)
	}
}
