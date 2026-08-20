package middleware

import "net/http"

// SecurityHeaders is the policy applied by SecurityResponseHeaders. The
// values mirror the legacy TypeScript implementation: a tight default set
// suitable for API responses, with optional HSTS and content security
// policy additions for HTML and HTTPS endpoints.
type SecurityHeaders struct {
	// HTML enables the HTML-only directives (frame deny, console CSP).
	HTML bool
	// HTTPS enables HSTS unconditionally. When false, HSTS is enabled
	// only if the request was served over HTTPS.
	HTTPS bool
	// NoStore adds Cache-Control: no-store.
	NoStore bool
}

// SecurityResponseHeaders applies the trusted response header policy. It
// sets the headers on the writer before delegating so the underlying
// handler can still override individual values when needed.
func SecurityResponseHeaders(policy SecurityHeaders) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=(), payment=()")
			h.Set("Cross-Origin-Opener-Policy", "same-origin")
			h.Set("Cross-Origin-Resource-Policy", "same-origin")
			h.Set("X-Robots-Tag", "noindex, nofollow")
			if policy.NoStore {
				h.Set("Cache-Control", "no-store")
			}
			if policy.HTML {
				h.Set("X-Frame-Options", "DENY")
				h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'")
			}
			if policy.HTTPS || requestUsesHTTPS(r) {
				h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
			}
			next.ServeHTTP(w, r)
		})
	}
}

func requestUsesHTTPS(r *http.Request) bool {
	if r == nil {
		return false
	}
	if r.TLS != nil {
		return true
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto == "https" {
		return true
	}
	return false
}
