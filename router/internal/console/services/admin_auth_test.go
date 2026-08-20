package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	dbmodels "github.com/cartethyia/daemon/internal/storage/models"
	. "github.com/cartethyia/daemon/internal/console/api"

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

	result, err := svc.Login(context.Background(), LoginInput{Username: "admin", Password: "s3cret-pass"}, AuthRequest{IP: "10.0.0.1"})
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

// decodeClaims extracts the JWT payload of a signed session token so tests
// can assert which claims a rotated token inherits.
func decodeClaims(t *testing.T, token string) sessionClaims {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token shape: %q", token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	var claims sessionClaims
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatalf("unmarshal claims: %v", err)
	}
	return claims
}

func TestRefreshRotatesSessionToken(t *testing.T) {
	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 4}}
	withStoredPassword(t, store, "pass", testSessionSecret)
	svc := newSessionAuthService(nil, nil, "")
	svc.settings = store

	loginAt := time.Unix(1_700_000_000, 0)
	svc.now = func() time.Time { return loginAt }
	login, err := svc.Login(context.Background(), LoginInput{Password: "pass"}, AuthRequest{IP: "10.0.0.1"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	oldToken := cookieValue(t, login.SetCookie)

	refreshAt := loginAt.Add(time.Hour)
	svc.now = func() time.Time { return refreshAt }
	refresh, err := svc.Refresh(context.Background(), oldToken, AuthRequest{BaseURL: "https://console.example.test"})
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if !strings.Contains(refresh.SetCookie, "cartethyia_session=") ||
		!strings.Contains(refresh.SetCookie, "Path=/") ||
		!strings.Contains(refresh.SetCookie, "HttpOnly") ||
		!strings.Contains(refresh.SetCookie, "SameSite=Strict") ||
		!strings.Contains(refresh.SetCookie, "Secure") {
		t.Fatalf("refresh cookie must match the login cookie contract: %q", refresh.SetCookie)
	}
	newToken := cookieValue(t, refresh.SetCookie)
	if newToken == oldToken {
		t.Fatal("refresh must issue a new token")
	}
	if refresh.MaxAge != login.MaxAge {
		t.Fatalf("rotated lifetime = %d, want %d", refresh.MaxAge, login.MaxAge)
	}

	// The new token must authenticate; old claims (role, password version)
	// carry over while the session id and expiry rotate.
	session, err := svc.Current(context.Background(), newToken)
	if err != nil {
		t.Fatalf("rotated token rejected: %v", err)
	}
	if session.ID != refresh.Session.ID || session.User != "admin" {
		t.Fatalf("rotated session: %+v vs %+v", session, refresh.Session)
	}
	oldClaims := decodeClaims(t, oldToken)
	newClaims := decodeClaims(t, newToken)
	if newClaims.PV != oldClaims.PV || newClaims.Role != oldClaims.Role {
		t.Fatalf("claims must carry over: old=%+v new=%+v", oldClaims, newClaims)
	}
	if newClaims.JTI == oldClaims.JTI {
		t.Fatal("rotated token must have a fresh session id")
	}
	if newClaims.EXP <= oldClaims.EXP {
		t.Fatalf("rotated expiry %d must outlive the original %d", newClaims.EXP, oldClaims.EXP)
	}
}

func TestRefreshPreservesRememberSessionLifetime(t *testing.T) {
	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 1}}
	withStoredPassword(t, store, "pass", testSessionSecret)
	svc := newSessionAuthService(nil, nil, "")
	svc.settings = store

	login, err := svc.Login(context.Background(), LoginInput{Password: "pass", Remember: true}, AuthRequest{IP: "10.0.0.8"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	refresh, err := svc.Refresh(context.Background(), cookieValue(t, login.SetCookie), AuthRequest{IP: "10.0.0.8"})
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if refresh.MaxAge != int(rememberSessionTTL/time.Second) {
		t.Fatalf("remember lifetime lost: %d", refresh.MaxAge)
	}
}

func TestRefreshRejectsInvalidAndStaleTokens(t *testing.T) {
	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 1}}
	withStoredPassword(t, store, "pass", testSessionSecret)
	svc := newSessionAuthService(nil, nil, "")
	svc.settings = store

	login, err := svc.Login(context.Background(), LoginInput{Password: "pass"}, AuthRequest{IP: "10.0.0.9"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if _, err := svc.Refresh(context.Background(), "not-a-token", AuthRequest{}); err == nil {
		t.Fatal("garbage token must be rejected")
	}

	store.rows.PasswordVersion = 2
	svc.snapshot = dbmodels.Settings{} // force cache refresh
	svc.snapAt = time.Time{}
	_, err = svc.Refresh(context.Background(), cookieValue(t, login.SetCookie), AuthRequest{})
	if err == nil {
		t.Fatal("stale password version must be rejected")
	}
	if adminError, ok := err.(*Error); !ok || adminError.Code != CodeAdminAuthentication {
		t.Fatalf("refresh error: %v", err)
	}

	if _, err := svc.Refresh(context.Background(), "", AuthRequest{}); err == nil {
		t.Fatal("missing token must be rejected")
	}
}

func TestLoginRejectsWrongPasswordAndUninitialized(t *testing.T) {
	uninitialized := testAuthService(t, nil)
	if _, err := uninitialized.Login(context.Background(), LoginInput{Password: "x"}, AuthRequest{IP: "10.0.0.2"}); err == nil {
		t.Fatal("expected uninitialized rejection")
	}

	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 1}}
	withStoredPassword(t, store, "right", testSessionSecret)
	svc := newSessionAuthService(nil, nil, "")
	svc.settings = store
	for i := 0; i < 3; i++ {
		if _, err := svc.Login(context.Background(), LoginInput{Password: "wrong"}, AuthRequest{IP: "10.0.0.3"}); err == nil {
			t.Fatal("expected wrong-password rejection")
		}
	}
	if _, err := svc.Login(context.Background(), LoginInput{Password: "right"}, AuthRequest{IP: "10.0.0.4"}); err != nil {
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
		_, lastErr = svc.Login(context.Background(), LoginInput{Password: "wrong"}, AuthRequest{IP: "10.0.0.9"})
	}
	if lastErr == nil {
		t.Fatal("expected failures")
	}
	_, err := svc.Login(context.Background(), LoginInput{Password: "right"}, AuthRequest{IP: "10.0.0.9"})
	if err == nil {
		t.Fatal("expected rate limit")
	}
	if adminError, ok := err.(*Error); !ok || adminError.Code != CodeRateLimited {
		t.Fatalf("rate limit error: %v", err)
	}
}

func TestBootstrapPasswordSeedsFirstLogin(t *testing.T) {
	store := &fakeConsoleSettings{rows: dbmodels.Settings{PasswordVersion: 1}}
	svc := newSessionAuthService(nil, nil, "bootstrap-pass")
	svc.settings = store

	if _, err := svc.Login(context.Background(), LoginInput{Password: "bootstrap-pass"}, AuthRequest{IP: "10.0.0.5"}); err != nil {
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

	result, err := svc.Login(context.Background(), LoginInput{Password: "pass"}, AuthRequest{IP: "10.0.0.6"})
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
	result, err := svc.Login(context.Background(), LoginInput{Password: "pass"}, AuthRequest{IP: "10.0.0.7", BaseURL: "https://console.example.test"})
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
