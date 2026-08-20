package auth

import (
	"strings"
	"testing"
	"time"
)

func TestImportKiroJSONNormalizesMetadataWithoutExposingSecrets(t *testing.T) {
	now := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	imported, err := ImportKiroJSON(`{"accessToken":"access-secret","refresh_token":"refresh-secret","expiresIn":120,"profileArn":"profile-1","scope":["a","b"]}`, now)
	if err != nil {
		t.Fatal(err)
	}
	if imported.TokenSet == nil || !imported.TokenSet.Valid() {
		t.Fatal("import did not return a valid token set")
	}
	defer imported.TokenSet.Close()
	if imported.TokenSet.ExpiresAt != now.Add(120*time.Second) || imported.TokenSet.Scope != "a b" {
		t.Fatalf("metadata = %#v", imported.TokenSet)
	}
	if imported.Labels["profileArn"] != "profile-1" || imported.Labels["mode"] != "manual-json" {
		t.Fatalf("labels = %#v", imported.Labels)
	}
	if strings.Contains(imported.TokenSet.Access.String(), "access-secret") || strings.Contains(imported.TokenSet.Refresh.String(), "refresh-secret") {
		t.Fatal("imported secret was exposed by String")
	}
}

func TestImportKiroJSONRejectsMalformedOrIncompleteDocuments(t *testing.T) {
	for _, raw := range []string{"", "{", `{"access_token":"only-access"}`} {
		if _, err := ImportKiroJSON(raw, time.Now()); err == nil {
			t.Fatalf("ImportKiroJSON(%q) unexpectedly succeeded", raw)
		}
	}
}

func TestParseKiroCallbackBoundsAndRejectsDeniedFlow(t *testing.T) {
	if _, _, err := ParseKiroCallback("kiro://kiro.kiroAgent/authenticate-success?error=access_denied"); err == nil {
		t.Fatal("denied callback unexpectedly succeeded")
	}
	code, state, err := ParseKiroCallback("kiro://kiro.kiroAgent/authenticate-success?code=abc&state=xyz")
	if err != nil || code != "abc" || state != "xyz" {
		t.Fatalf("callback = %q, %q, %v", code, state, err)
	}
}
