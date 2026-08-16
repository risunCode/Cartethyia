package drivers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
)

func check(t *testing.T, d accounts.AuthDriver, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("driver constructor failed: %v", err)
	}
	if d == nil {
		t.Fatal("driver is nil")
	}
}

func TestAllConstructors(t *testing.T) {
	d1, e1 := NewAnthropic(Config{ProviderID: "anthropic"})
	check(t, d1, e1)
	d2, e2 := NewAnthropicDefault()
	check(t, d2, e2)
	d3, e3 := NewAntigravity(Config{ProviderID: "antigravity"})
	check(t, d3, e3)
	d4, e4 := NewAntigravityDefault()
	check(t, d4, e4)
	d5, e5 := NewCline(Config{ProviderID: "cline"})
	check(t, d5, e5)
	d6, e6 := NewClineDefault()
	check(t, d6, e6)
	d7, e7 := NewClinePass(Config{ProviderID: "cline-pass"})
	check(t, d7, e7)
	d8, e8 := NewClinePassDefault()
	check(t, d8, e8)
	d9, e9 := NewCodex(Config{ProviderID: "codex"})
	check(t, d9, e9)
	d10, e10 := NewCodexDefault()
	check(t, d10, e10)
	d11, e11 := NewGrokBuild(Config{ProviderID: "grok-build"})
	check(t, d11, e11)
	d12, e12 := NewGrokBuildDefault()
	check(t, d12, e12)
	d13, e13 := NewKimchi(Config{ProviderID: "kimchi"})
	check(t, d13, e13)
	d14, e14 := NewKimchiDefault()
	check(t, d14, e14)
	d15, e15 := NewKiroDefault()
	check(t, d15, e15)
}

func TestNormalizeID(t *testing.T) {
	cases := map[string]string{
		"claude":      "claude",
		"ANTHROPIC":   "anthropic",
		"grok":        ProviderGrokBuild,
		"cline-pass":  ProviderClinePass,
		"unknown-xyz": "unknown-xyz",
	}
	for in, want := range cases {
		if got := NormalizeID(in); got != want {
			t.Errorf("NormalizeID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDriverHelpers(t *testing.T) {
	if got := firstNonEmpty("", "  ", "hello", "world"); got != "hello" {
		t.Fatalf("firstNonEmpty = %q", got)
	}
	if got := nonEmptyStrings([]string{"a"}, []string{"b"}); len(got) != 1 || got[0] != "a" {
		t.Fatalf("nonEmptyStrings first = %+v", got)
	}
	if got := nonEmptyStrings(nil, []string{"b"}); len(got) != 1 || got[0] != "b" {
		t.Fatalf("nonEmptyStrings fallback = %+v", got)
	}
	if got := bounded("123456789", 5); got != "12345" {
		t.Fatalf("bounded = %q", got)
	}
	m := map[string]any{"num": float64(42), "str": json.Number("100"), "bad": "not-a-number"}
	if got := intField(m, "num"); got != 42 {
		t.Fatalf("intField num = %d", got)
	}
	if got := intField(m, "str"); got != 100 {
		t.Fatalf("intField str = %d", got)
	}
	if got := intField(m, "bad"); got != 0 {
		t.Fatalf("intField bad = %d", got)
	}

	// jwtClaims
	validJWT := "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
	claims := jwtClaims(validJWT)
	if claims["sub"] != "1234567890" {
		t.Fatalf("jwt claims sub = %v", claims["sub"])
	}
	if bad := jwtClaims("not.a.valid.jwt"); len(bad) != 0 {
		t.Fatalf("bad jwt claims = %v", bad)
	}
}

func TestDriverEnrichIdentity(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"sub":"user-123","email":"u@example.com","org_id":"org-456","org_name":"Acme"}`))
	}))
	defer ts.Close()

	d := &HTTPDriver{
		cfg: Config{
			ProviderID: "custom",
			Endpoints:  Endpoints{UserInfo: ts.URL},
		},
		timeout: 5 * time.Second,
		client:  ts.Client(),
		maxBody: 64 * 1024,
	}

	token := &accounts.TokenSet{
		Access: accounts.NewSecret([]byte("tok-1")),
	}
	if err := d.enrichIdentity(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if token.ProviderAccountID != "user-123" || token.Email != "u@example.com" || token.OrgID != "org-456" {
		t.Fatalf("enriched token = %+v", token)
	}
}

func TestDriverRevoke(t *testing.T) {
	called := false
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	d := &HTTPDriver{
		cfg: Config{
			ProviderID:   "custom",
			Capabilities: accounts.Capabilities{Revoke: true},
			Endpoints:    Endpoints{Revoke: ts.URL},
		},
		timeout: 5 * time.Second,
		client:  ts.Client(),
		maxBody: 64 * 1024,
	}

	sec := accounts.NewSecret([]byte("token-to-revoke"))
	if err := d.Revoke(context.Background(), accounts.RevokeTokenInput{Token: sec}); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("revocation endpoint not called")
	}

	// Revoke on driver with no capability
	dNoRevoke := &HTTPDriver{cfg: Config{ProviderID: "custom"}}
	if err := dNoRevoke.Revoke(context.Background(), accounts.RevokeTokenInput{Token: sec}); err == nil {
		t.Fatal("expected unsupported error")
	}
}
