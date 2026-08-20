package middleware

import (
	"net/http/httptest"
	"testing"
)

func TestClientKeyRequiresExplicitForwardedTrust(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "192.0.2.10:1234"
	req.Header.Set("X-Forwarded-For", "198.51.100.20, 192.0.2.10")
	if got := ClientKey(req); got != "192.0.2.10" {
		t.Fatalf("untrusted key=%q", got)
	}
	if got := ClientKeyWithTrust(req, true); got != "198.51.100.20" {
		t.Fatalf("trusted key=%q", got)
	}
}

func TestDetectClientFamiliesAndUnknown(t *testing.T) {
	cases := []struct {
		ua     string
		family string
		source string
	}{
		{ua: "curl/8.7.1", family: "curl", source: "user_agent"},
		{ua: "Codex/1.2.3", family: "codex", source: "user_agent"},
		{ua: "", family: "unknown", source: "none"},
	}
	for _, tc := range cases {
		req := httptest.NewRequest("GET", "/", nil)
		req.Header.Set("User-Agent", tc.ua)
		got := DetectClient(req)
		if got.Family != tc.family || got.Source != tc.source {
			t.Fatalf("ua=%q identity=%+v", tc.ua, got)
		}
	}
}
