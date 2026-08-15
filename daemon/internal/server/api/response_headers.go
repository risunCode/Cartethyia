package api

import (
	"mime"
	"net/http"
	"strings"
)

const (
	HeaderUpstreamRequestID                  = "X-Cartethyia-Upstream-Request-Id"
	HeaderUpstreamRateLimitLimit             = "X-Cartethyia-Upstream-RateLimit-Limit"
	HeaderUpstreamRateLimitRemaining         = "X-Cartethyia-Upstream-RateLimit-Remaining"
	HeaderUpstreamRateLimitReset             = "X-Cartethyia-Upstream-RateLimit-Reset"
	HeaderUpstreamRateLimitLimitRequests     = "X-Cartethyia-Upstream-RateLimit-Limit-Requests"
	HeaderUpstreamRateLimitRemainingRequests = "X-Cartethyia-Upstream-RateLimit-Remaining-Requests"
	HeaderUpstreamRateLimitResetRequests     = "X-Cartethyia-Upstream-RateLimit-Reset-Requests"
	HeaderUpstreamRateLimitLimitTokens       = "X-Cartethyia-Upstream-RateLimit-Limit-Tokens"
	HeaderUpstreamRateLimitRemainingTokens   = "X-Cartethyia-Upstream-RateLimit-Remaining-Tokens"
	HeaderUpstreamRateLimitResetTokens       = "X-Cartethyia-Upstream-RateLimit-Reset-Tokens"
)

const maxSafeUpstreamHeaderValueBytes = 256

type upstreamHeaderRule struct {
	destination string
	sources     []string
}

var safeUpstreamMetadataRules = []upstreamHeaderRule{
	{HeaderUpstreamRequestID, []string{"OpenAI-Request-Id", "Anthropic-Request-Id", "X-Goog-Request-Id", "X-Request-Id", "Request-Id"}},
	{HeaderUpstreamRateLimitLimit, []string{"RateLimit-Limit"}},
	{HeaderUpstreamRateLimitRemaining, []string{"RateLimit-Remaining"}},
	{HeaderUpstreamRateLimitReset, []string{"RateLimit-Reset"}},
	{HeaderUpstreamRateLimitLimitRequests, []string{"X-RateLimit-Limit-Requests", "X-RateLimit-Limit"}},
	{HeaderUpstreamRateLimitRemainingRequests, []string{"X-RateLimit-Remaining-Requests", "X-RateLimit-Remaining"}},
	{HeaderUpstreamRateLimitResetRequests, []string{"X-RateLimit-Reset-Requests", "X-RateLimit-Reset"}},
	{HeaderUpstreamRateLimitLimitTokens, []string{"X-RateLimit-Limit-Tokens"}},
	{HeaderUpstreamRateLimitRemainingTokens, []string{"X-RateLimit-Remaining-Tokens"}},
	{HeaderUpstreamRateLimitResetTokens, []string{"X-RateLimit-Reset-Tokens"}},
}

// CopySafeUpstreamResponseHeaders applies the only upstream-to-client header
// policy. It never clears or replaces Cartethyia-owned headers already in dst,
// including Cache-Control. Unknown, hop-by-hop, cookie, credential, proxy, and
// internal-routing headers are ignored because this function copies only the
// fixed allowlist below.
func CopySafeUpstreamResponseHeaders(dst, upstream http.Header) {
	if dst == nil || upstream == nil {
		return
	}
	if _, owned := dst[http.CanonicalHeaderKey("Content-Type")]; !owned {
		if contentType, ok := safeContentType(headerValueFold(upstream, "Content-Type")); ok {
			dst.Set("Content-Type", contentType)
		}
	}
	for _, rule := range safeUpstreamMetadataRules {
		if _, owned := dst[http.CanonicalHeaderKey(rule.destination)]; owned {
			continue
		}
		for _, source := range rule.sources {
			if value, ok := safeUpstreamMetadataValue(headerValueFold(upstream, source)); ok {
				dst.Set(rule.destination, value)
				break
			}
		}
	}
}

func headerValueFold(headers http.Header, name string) string {
	if values, ok := headers[name]; ok && len(values) > 0 {
		return values[0]
	}
	canonical := http.CanonicalHeaderKey(name)
	if values, ok := headers[canonical]; ok && len(values) > 0 {
		return values[0]
	}
	for key, values := range headers {
		if strings.EqualFold(key, name) && len(values) > 0 {
			return values[0]
		}
	}
	return ""
}

// SafeUpstreamResponseContentType accepts only API response media types that
// Cartethyia knows how to serve safely.
func SafeUpstreamResponseContentType(value string) (string, bool) {
	return safeContentType(value)
}

func safeContentType(value string) (string, bool) {
	mediaType, params, err := mime.ParseMediaType(strings.TrimSpace(value))
	if err != nil {
		return "", false
	}
	for name, value := range params {
		if !strings.EqualFold(name, "charset") || !strings.EqualFold(value, "utf-8") {
			return "", false
		}
	}
	switch strings.ToLower(mediaType) {
	case "application/json", "text/event-stream":
		return mime.FormatMediaType(strings.ToLower(mediaType), params), true
	default:
		return "", false
	}
}

func safeUpstreamMetadataValue(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxSafeUpstreamHeaderValueBytes {
		return "", false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x20 || value[i] > 0x7e {
			return "", false
		}
	}
	lower := strings.ToLower(value)
	for _, marker := range []string{"authorization", "bearer ", "api_key", "apikey", "access_token", "refresh_token", "client_secret", "password", "cookie"} {
		if strings.Contains(lower, marker) {
			return "", false
		}
	}
	return value, true
}
