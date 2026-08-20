package middleware

import (
	"net"
	"net/http"
	"regexp"
	"strings"
)

// ClientIdentity is bounded metadata for analytics and request evidence.
// User-agent classification is advisory and never an authorization signal.
type ClientIdentity struct {
	Family     string
	Source     string
	Confidence string
	Version    string
}

// ClientKey returns the connection identity without trusting client-supplied
// forwarded headers. Deployments behind a trusted ingress should call
// ClientKeyWithTrust explicitly after establishing that trust boundary.
func ClientKey(r *http.Request) string {
	return ClientKeyWithTrust(r, false)
}

// ClientKeyWithTrust returns the first forwarded address only when the caller
// explicitly trusts the ingress. Untrusted requests use the socket peer.
func ClientKeyWithTrust(r *http.Request, trustForwarded bool) string {
	if r == nil {
		return ""
	}
	if trustForwarded {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if first := firstForwardedFor(xff); first != "" {
				return first
			}
		}
	}
	if r.RemoteAddr != "" {
		if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
			return host
		}
		return r.RemoteAddr
	}
	return ""
}

var clientVersionPattern = regexp.MustCompile(`(?i)(?:version|/)([0-9]+(?:\.[0-9]+){0,2})`)

// DetectClient classifies common client families from bounded User-Agent
// metadata. Unknown and absent values remain explicit; headers are never
// copied into analytics rows.
func DetectClient(r *http.Request) ClientIdentity {
	if r == nil {
		return ClientIdentity{Family: "unknown", Source: "none", Confidence: "low"}
	}
	ua := strings.TrimSpace(r.UserAgent())
	lower := strings.ToLower(ua)
	family := "unknown"
	confidence := "low"
	switch {
	case strings.Contains(lower, "oh-my-pi") || strings.Contains(lower, "oh_my_pi") || strings.Contains(lower, "omp/"):
		family, confidence = "oh_my_pi", "high"
	case strings.Contains(lower, "claude-code"):
		family, confidence = "claude_code", "high"
	case strings.Contains(lower, "opencode"):
		family, confidence = "opencode", "high"
	case strings.Contains(lower, "codex"):
		family, confidence = "codex", "high"
	case strings.HasPrefix(lower, "curl/"):
		family, confidence = "curl", "high"
	case strings.Contains(lower, "mozilla/") && (strings.Contains(lower, "chrome/") || strings.Contains(lower, "safari/") || strings.Contains(lower, "firefox/")):
		family, confidence = "browser", "medium"
	}
	version := ""
	if match := clientVersionPattern.FindStringSubmatch(ua); len(match) == 2 {
		version = match[1]
	}
	if len(version) > 32 {
		version = version[:32]
	}
	if len(ua) > 256 {
		ua = ua[:256]
	}
	if ua == "" {
		return ClientIdentity{Family: family, Source: "none", Confidence: confidence, Version: version}
	}
	return ClientIdentity{Family: family, Source: "user_agent", Confidence: confidence, Version: version}
}

func firstForwardedFor(header string) string {
	for _, entry := range strings.Split(header, ",") {
		candidate := strings.TrimSpace(entry)
		if candidate == "" {
			continue
		}
		if host, _, err := net.SplitHostPort(candidate); err == nil {
			candidate = host
		}
		if candidate != "" {
			return candidate
		}
	}
	return ""
}
