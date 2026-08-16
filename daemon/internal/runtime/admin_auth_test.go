package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	dbmodels "github.com/cartethyia/daemon/internal/database/models"
	adminserver "github.com/cartethyia/daemon/internal/server/admin"
)

type fakeConsoleSettings struct {
	rows    dbmodels.Settings
	getErr  error
	ensureN int
}

func (f *fakeConsoleSettings) Ensure(context.Context) (dbmodels.Settings, error) {
	f.ensureN++
	return f.rows, f.getErr
}

func (f *fakeConsoleSettings) Get(context.Context) (dbmodels.Settings, error) {
	return f.rows, f.getErr
}

func (f *fakeConsoleSettings) SetPasswordHash(_ context.Context, hash string) error {
	f.rows.PasswordHash = hash
	return nil
}

func (f *fakeConsoleSettings) RotateJWTSecret(_ context.Context, secret string) error {
	f.rows.JWTSecret = secret
	return nil
}

func testAuthService(t *testing.T, mutate func(*fakeConsoleSettings)) *sessionAuthService {
	t.Helper()
	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 1}}
	if mutate != nil {
		mutate(store)
	}
	svc := newSessionAuthService(nil, nil, "")
	svc.settings = store
	svc.bootstrapPassword = ""
	return svc
}

func withStoredPassword(t *testing.T, store *fakeConsoleSettings, password, secret string) {
	t.Helper()
	hash, err := hashConsolePassword(password)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	store.rows.PasswordHash = hash
	store.rows.JWTSecret = secret
}

const testSessionSecret = "0123456789abcdef0123456789abcdef0123456789abcdef"

func TestSignAndVerifySessionTokenRoundTrip(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	token, jti, issued, expires, err := signSessionToken(testSessionSecret, 3, time.Hour, func() time.Time { return now })
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if jti == "" || len(jti) != 32 {
		t.Fatalf("jti shape: %q", jti)
	}
	if !expires.Equal(issued.Add(time.Hour)) {
		t.Fatalf("expiry window: %v -> %v", issued, expires)
	}
	claims, err := verifySessionToken(token, testSessionSecret, 3, func() time.Time { return now.Add(time.Minute) })
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims.JTI != jti || claims.PV != 3 || claims.Role != "admin" {
		t.Fatalf("claims: %+v", claims)
	}
}

func TestVerifySessionTokenRejectsBadInput(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	token, _, _, _, err := signSessionToken(testSessionSecret, 1, time.Hour, func() time.Time { return now })
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	checks := map[string]func() error{
		"empty":      func() error { _, err := verifySessionToken("", testSessionSecret, 1, nowFn(now)); return err },
		"garbage":    func() error { _, err := verifySessionToken("abc", testSessionSecret, 1, nowFn(now)); return err },
		"bad secret": func() error { _, err := verifySessionToken(token, strings.Repeat("x", 64), 1, nowFn(now)); return err },
		"expired": func() error {
			_, err := verifySessionToken(token, testSessionSecret, 1, nowFn(now.Add(2*time.Hour)))
			return err
		},
		"stale pv": func() error { _, err := verifySessionToken(token, testSessionSecret, 2, nowFn(now)); return err },
		"short token": func() error {
			_, err := verifySessionToken(token[:len(token)-2], testSessionSecret, 1, nowFn(now))
			return err
		},
	}
	for name, check := range checks {
		if err := check(); err == nil {
			t.Errorf("%s: expected rejection", name)
		}
	}
	// Tampered payload must fail the constant-time signature check.
	parts := strings.Split(token, ".")
	tampered := parts[0] + "." + tamperClaims(t, parts[1]) + "." + parts[2]
	if _, err := verifySessionToken(tampered, testSessionSecret, 1, nowFn(now)); err == nil {
		t.Error("tampered payload: expected rejection")
	}
}

func tamperClaims(t *testing.T, payload string) string {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	claims["exp"] = claims["exp"].(float64) + 3_600_000
	forged, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(forged)
}

func nowFn(at time.Time) func() time.Time { return func() time.Time { return at } }

func TestHashAndVerifyConsolePassword(t *testing.T) {
	hash, err := hashConsolePassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("phc prefix: %q", hash)
	}
	if !verifyConsolePassword(hash, "correct horse battery staple") {
		t.Error("correct password rejected")
	}
	if verifyConsolePassword(hash, "wrong password") {
		t.Error("wrong password accepted")
	}
	if verifyConsolePassword("not-a-phc-string", "x") {
		t.Error("malformed hash accepted")
	}
	if verifyConsolePassword("$argon2id$v=19$m=19456,t=2,p=1$###$???", "x") {
		t.Error("undecodable salt accepted")
	}
}

func TestLoginIssuesCookieAndCurrentValidates(t *testing.T) {
	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 4}}
	withStoredPassword(t, store, "s3cret-pass", testSessionSecret)
	svc := newSessionAuthService(nil, nil, "")
	svc.settings = store

	result, err := svc.Login(context.Background(), adminserver.LoginInput{Username: "admin", Password: "s3cret-pass"}, adminserver.AuthRequest{IP: "10.0.0.1"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if result.Session.User != "admin" || len(result.Session.Scopes) != 1 || result.Session.Scopes[0] != "admin:*" {
		t.Fatalf("session: %+v", result.Session)
	}
	if !strings.Contains(result.SetCookie, "cartethyia_session=") || !strings.Contains(result.SetCookie, "HttpOnly") || !strings.Contains(result.SetCookie, "SameSite=Strict") {
		t.Fatalf("cookie: %q", result.SetCookie)
	}
	if result.MaxAge != int(defaultSessionTTL/time.Second) {
		t.Fatalf("max age: %d", result.MaxAge)
	}

	session, err := svc.Current(context.Background(), cookieValue(t, result.SetCookie))
	if err != nil {
		t.Fatalf("current: %v", err)
	}
	if session.ID != result.Session.ID || session.User != "admin" {
		t.Fatalf("current session: %+v", session)
	}
}

func cookieValue(t *testing.T, cookie string) string {
	t.Helper()
	parts := strings.SplitN(strings.SplitN(cookie, ";", 2)[0], "=", 2)
	if len(parts) != 2 {
		t.Fatalf("cookie shape: %q", cookie)
	}
	return parts[1]
}

func TestLoginRejectsWrongPasswordAndUninitialized(t *testing.T) {
	uninitialized := testAuthService(t, nil)
	if _, err := uninitialized.Login(context.Background(), adminserver.LoginInput{Password: "x"}, adminserver.AuthRequest{IP: "10.0.0.2"}); err == nil {
		t.Fatal("expected uninitialized rejection")
	}

	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 1}}
	withStoredPassword(t, store, "right", testSessionSecret)
	svc := newSessionAuthService(nil, nil, "")
	svc.settings = store
	for i := 0; i < 3; i++ {
		if _, err := svc.Login(context.Background(), adminserver.LoginInput{Password: "wrong"}, adminserver.AuthRequest{IP: "10.0.0.3"}); err == nil {
			t.Fatal("expected wrong-password rejection")
		}
	}
	if _, err := svc.Login(context.Background(), adminserver.LoginInput{Password: "right"}, adminserver.AuthRequest{IP: "10.0.0.4"}); err != nil {
		t.Fatalf("other ip should still log in: %v", err)
	}
}

func TestLoginRateLimit(t *testing.T) {
	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 1}}
	withStoredPassword(t, store, "right", testSessionSecret)
	svc := newSessionAuthService(nil, nil, "")
	svc.settings = store

	var lastErr error
	for i := 0; i < loginRateMaxFailures; i++ {
		_, lastErr = svc.Login(context.Background(), adminserver.LoginInput{Password: "wrong"}, adminserver.AuthRequest{IP: "10.0.0.9"})
	}
	if lastErr == nil {
		t.Fatal("expected failures")
	}
	_, err := svc.Login(context.Background(), adminserver.LoginInput{Password: "right"}, adminserver.AuthRequest{IP: "10.0.0.9"})
	if err == nil {
		t.Fatal("expected rate limit")
	}
	if adminError, ok := err.(*adminserver.Error); !ok || adminError.Code != adminserver.CodeRateLimited {
		t.Fatalf("rate limit error: %v", err)
	}
}

func TestBootstrapPasswordSeedsFirstLogin(t *testing.T) {
	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 1}}
	svc := newSessionAuthService(nil, nil, "bootstrap-pass")
	svc.settings = store

	if _, err := svc.Login(context.Background(), adminserver.LoginInput{Password: "bootstrap-pass"}, adminserver.AuthRequest{IP: "10.0.0.5"}); err != nil {
		t.Fatalf("bootstrap login: %v", err)
	}
	if store.rows.PasswordHash == "" || store.rows.JWTSecret == "" {
		t.Fatalf("bootstrap did not persist: %+v", store.rows)
	}
	if !verifyConsolePassword(store.rows.PasswordHash, "bootstrap-pass") {
		t.Error("seeded hash does not verify")
	}
}

func TestCurrentRejectsPasswordVersionBump(t *testing.T) {
	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 1}}
	withStoredPassword(t, store, "pass", testSessionSecret)
	svc := newSessionAuthService(nil, nil, "")
	svc.settings = store

	result, err := svc.Login(context.Background(), adminserver.LoginInput{Password: "pass"}, adminserver.AuthRequest{IP: "10.0.0.6"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	store.rows.PasswordVersion = 2
	svc.snapshot = dbmodels.Settings{} // force cache refresh
	svc.snapAt = time.Time{}
	if _, err := svc.Current(context.Background(), cookieValue(t, result.SetCookie)); err == nil {
		t.Fatal("expected stale password-version rejection")
	}
}

func TestSecureCookieOnHTTPS(t *testing.T) {
	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 1}}
	withStoredPassword(t, store, "pass", testSessionSecret)
	svc := newSessionAuthService(nil, nil, "")
	svc.settings = store
	result, err := svc.Login(context.Background(), adminserver.LoginInput{Password: "pass"}, adminserver.AuthRequest{IP: "10.0.0.7", BaseURL: "https://console.example.test"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if !strings.Contains(result.SetCookie, "Secure") {
		t.Fatalf("expected Secure cookie: %q", result.SetCookie)
	}
	if len(result.SetCookie) > 0 && strings.Contains(func() string { http := buildSessionCookie("t", 60, false); return http }(), "Secure") {
		t.Fatal("plain cookie must not be Secure")
	}
}

func TestBoundedLoginKey(t *testing.T) {
	if got := boundedLoginKey(""); got != "unknown" {
		t.Fatalf("empty key: %q", got)
	}
	if got := boundedLoginKey(fmt.Sprintf("%0256d", 1)); len(got) != 64 {
		t.Fatalf("bounded length: %d", len(got))
	}
}
