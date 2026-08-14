package drivers

import (
	"context"
	"testing"

	"github.com/cartethyia/daemon/internal/accounts"
)

func TestSupportedDriverRegistryMatrixAndExclusions(t *testing.T) {
	registry, err := NewRegistry(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, providerID := range []string{"antigravity", "claude", "cline", "clinepass", "codex", "grok-build", "kimchi", "kiro"} {
		driver, ok := registry.Get(providerID)
		if !ok || driver == nil {
			t.Fatalf("driver %q missing", providerID)
		}
		info, ok := driver.(accounts.DriverInfo)
		if !ok || info.ID() != providerID {
			t.Fatalf("driver %q does not expose matching identity", providerID)
		}
	}
	for _, excluded := range []string{"devin", "cursor", "cursorcli"} {
		if _, ok := registry.Get(excluded); ok {
			t.Fatalf("excluded driver %q is registered", excluded)
		}
	}
}

func TestKimchiRemainsAccessOnly(t *testing.T) {
	registry, err := NewRegistry(nil)
	if err != nil {
		t.Fatal(err)
	}
	driver, ok := registry.Get("kimchi")
	if !ok || driver == nil {
		t.Fatal("kimchi driver missing")
	}
	info, ok := driver.(accounts.DriverInfo)
	if !ok {
		t.Fatal("kimchi driver identity contract missing")
	}
	if info.Capabilities().Refresh || !info.Capabilities().AccessOnly {
		t.Fatalf("kimchi capabilities = %#v", info.Capabilities())
	}
	_, err = driver.Refresh(context.Background(), accounts.RefreshTokenInput{ProviderID: "kimchi", AccountID: "fixture", RefreshToken: accounts.NewSecretFromString("refresh")})
	if err == nil {
		t.Fatal("access-only Kimchi refresh unexpectedly succeeded")
	}
}

func TestOhMyPiOAuthClientConfigurationIsPreserved(t *testing.T) {
	antigravity := defaultConfig(ProviderAntigravity)
	if antigravity.ClientID != "REPLACE_WITH_GOOGLE_CLIENT_ID" || antigravity.ClientSecret == nil || antigravity.ClientSecret.IsZero() {
		t.Fatal("Antigravity Google OAuth client configuration is incomplete")
	}
	if antigravity.RedirectURI != "http://127.0.0.1:51121/oauth-callback" {
		t.Fatalf("Antigravity redirect URI = %q", antigravity.RedirectURI)
	}
	claude := defaultConfig(ProviderClaude)
	if claude.ClientID != "9d1c250a-e61b-44d9-88ed-5944d1962f5e" {
		t.Fatalf("Claude OAuth client id = %q", claude.ClientID)
	}
	for _, scope := range []string{"org:create_api_key", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"} {
		found := false
		for _, candidate := range claude.Scopes {
			if candidate == scope {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("Claude OAuth scope %q missing", scope)
		}
	}
}
