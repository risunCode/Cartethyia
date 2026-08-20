package api

import (

	"net/http"
	"net/http/httptest"
	"testing"
)

// The per-IP login failure limiter keys on clientIP. Spoofed forwarding
// headers must not change the key unless CARTETHYIA_TRUST_PROXY explicitly
// declares a trusted reverse proxy in front of the daemon.
func TestLoginLimiterClientIPTrustGate(t *testing.T) {
	newRequest := func(xff string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "http://example.test/console/auth/login", nil)
		r.RemoteAddr = "198.51.100.10:5555"
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}

	t.Run("trust off by default ignores forwarded headers", func(t *testing.T) {
		r := newRequest("203.0.113.9, 10.0.0.1")
		if got := clientIP(r); got != "198.51.100.10" {
			t.Fatalf("spoofed X-Forwarded-For must not change limiter key: got %q", got)
		}
		r = newRequest("203.0.113.9")
		r.Header.Set("X-Real-IP", "203.0.113.8")
		if got := clientIP(r); got != "198.51.100.10" {
			t.Fatalf("spoofed X-Real-IP must not change limiter key: got %q", got)
		}
		r = newRequest("")
		if got := clientIP(r); got != "198.51.100.10" {
			t.Fatalf("plain remote address key: got %q", got)
		}
	})

	t.Run("trust off via explicit false", func(t *testing.T) {
		t.Setenv("CARTETHYIA_TRUST_PROXY", "false")
		if got := clientIP(newRequest("203.0.113.9")); got != "198.51.100.10" {
			t.Fatalf("explicit false must ignore XFF: got %q", got)
		}
	})

	t.Run("malformed flag fails closed", func(t *testing.T) {
		t.Setenv("CARTETHYIA_TRUST_PROXY", "yes-please")
		if got := clientIP(newRequest("203.0.113.9")); got != "198.51.100.10" {
			t.Fatalf("malformed flag must fail closed to untrusted: got %q", got)
		}
	})

	t.Run("trust on honors leftmost forwarded entry", func(t *testing.T) {
		t.Setenv("CARTETHYIA_TRUST_PROXY", "true")
		if got := clientIP(newRequest("203.0.113.9, 10.0.0.1")); got != "203.0.113.9" {
			t.Fatalf("trusted XFF leftmost: got %q", got)
		}
		if got := clientIP(newRequest("203.0.113.7:443")); got != "203.0.113.7" {
			t.Fatalf("trusted XFF host without port: got %q", got)
		}
		if got := clientIP(newRequest("")); got != "198.51.100.10" {
			t.Fatalf("missing XFF falls back to socket peer: got %q", got)
		}
	})
}
