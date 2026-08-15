package providers

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func TestClassifyResponseEvidenceMatrix(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name      string
		status    int
		body      string
		category  ResponseCategory
		code      string
		retryable bool
		alternate bool
		scope     contracts.RateScope
	}{
		{name: "success", status: http.StatusOK, category: CategorySuccess, code: "provider.success", scope: contracts.RateScopeRoute},
		{name: "refreshable authentication", status: http.StatusUnauthorized, body: `{"error":{"code":"token_expired"}}`, category: CategoryAuth, code: "provider.authentication_failed", retryable: true, alternate: true, scope: contracts.RateScopeAccount},
		{name: "authentication marker on forbidden", status: http.StatusForbidden, body: `{"error":{"code":"invalid_api_key"}}`, category: CategoryAuth, code: "provider.authentication_failed", retryable: true, alternate: true, scope: contracts.RateScopeAccount},
		{name: "entitlement", status: http.StatusForbidden, body: `{"error":{"code":"subscription_required"}}`, category: CategoryEntitlement, code: "provider.entitlement_denied", scope: contracts.RateScopeAccount},
		{name: "content policy", status: http.StatusForbidden, body: `{"error":{"code":"content_policy"}}`, category: CategoryContentPolicy, code: "provider.content_policy", scope: contracts.RateScopeRoute},
		{name: "rate limit", status: http.StatusTooManyRequests, body: `{"error":{"code":"rate_limit_exceeded"}}`, category: CategoryRateLimit, code: "provider.rate_limit", retryable: true, alternate: true, scope: contracts.RateScopeAccount},
		{name: "quota", status: http.StatusTooManyRequests, body: `{"error":{"code":"insufficient_quota"}}`, category: CategoryQuota, code: "provider.quota_exhausted", retryable: true, alternate: true, scope: contracts.RateScopeAccount},
		{name: "daily quota", status: http.StatusTooManyRequests, body: `{"error":{"code":"daily_quota_exhausted"}}`, category: CategoryQuota, code: "provider.daily_quota_exhausted", retryable: true, alternate: true, scope: contracts.RateScopeAccount},
		{name: "permanent billing quota", status: http.StatusPaymentRequired, body: `{"error":{"code":"billing_quota"}}`, category: CategoryQuota, code: "provider.quota_exhausted", scope: contracts.RateScopeAccount},
		{name: "capacity", status: http.StatusServiceUnavailable, body: `{"error":{"code":"model_capacity"}}`, category: CategoryCapacity, code: "provider.capacity", retryable: true, alternate: true, scope: contracts.RateScopeModel},
		{name: "empty output", status: http.StatusBadGateway, body: `{"output":[]}`, category: CategoryEmptyOutput, code: "provider.empty_output", retryable: true, alternate: true, scope: contracts.RateScopeModel},
		{name: "transient", status: http.StatusRequestTimeout, category: CategoryTransient, code: "provider.transient", retryable: true, alternate: true, scope: contracts.RateScopeProvider},
		{name: "server error", status: http.StatusInternalServerError, category: CategoryServerError, code: "provider.server_error", retryable: true, alternate: true, scope: contracts.RateScopeProvider},
		{name: "invalid request", status: http.StatusBadRequest, category: CategoryInvalidRequest, code: "provider.invalid_request", scope: contracts.RateScopeRoute},
		{name: "fatal", status: http.StatusFound, category: CategoryFatal, code: "provider.failed", scope: contracts.RateScopeProvider},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := ClassifyResponseEvidence(NewResponseEvidence(tc.status, nil, []byte(tc.body)))
			if got.StatusCode != tc.status || got.Category != tc.category || got.Code != tc.code || got.Retryable != tc.retryable || got.AlternateAccountEligible != tc.alternate || got.Scope != tc.scope || got.Phase != contracts.RatePhaseProvider {
				t.Fatalf("classification = %#v", got)
			}
		})
	}
}

func TestResponseEvidenceBoundsAndAllowlistedHeaders(t *testing.T) {
	t.Parallel()
	headers := make(http.Header)
	headers.Set("Retry-After", "17")
	headers.Set("X-RateLimit-Reset-Requests", "3s")
	headers.Set("Anthropic-Ratelimit-Tokens-Reset", "2030-01-01T00:00:00Z")
	headers.Set("Authorization", "Bearer credential-sentinel")
	headers.Set("Set-Cookie", "session=credential-sentinel")
	body := make([]byte, MaxResponseEvidenceBodyBytes+64)
	for i := range body {
		body[i] = 'x'
	}
	evidence := NewResponseEvidence(http.StatusTooManyRequests, headers, body)
	body[0] = 'y'
	if len(evidence.BodyPrefix) != MaxResponseEvidenceBodyBytes || evidence.BodyPrefix[0] != 'x' {
		t.Fatalf("body prefix was not copied and capped: len=%d first=%q", len(evidence.BodyPrefix), evidence.BodyPrefix[0])
	}
	if evidence.Headers.RetryAfter != "17" || evidence.Headers.RateLimitResetRequests != "3s" || evidence.Headers.AnthropicRateLimitTokensReset == "" {
		t.Fatalf("safe headers = %#v", evidence.Headers)
	}
	if strings.Contains(strings.ToLower(evidence.Headers.RetryAfter+evidence.Headers.RateLimitResetRequests+evidence.Headers.AnthropicRateLimitTokensReset), "credential-sentinel") {
		t.Fatal("non-allowlisted credential header entered evidence")
	}
}

func TestParseResponseRetryAfter(t *testing.T) {
	t.Parallel()
	now := time.Date(2030, time.January, 2, 3, 4, 5, 0, time.UTC)
	cases := []struct {
		name    string
		headers SafeResponseHeaders
		want    time.Duration
	}{
		{name: "delta seconds", headers: SafeResponseHeaders{RetryAfter: "12"}, want: 12 * time.Second},
		{name: "http date", headers: SafeResponseHeaders{RetryAfter: now.Add(20 * time.Second).Format(http.TimeFormat)}, want: 20 * time.Second},
		{name: "duration reset", headers: SafeResponseHeaders{RateLimitResetRequests: "1500ms"}, want: 1500 * time.Millisecond},
		{name: "unix reset", headers: SafeResponseHeaders{RateLimitReset: "1893553505"}, want: 60 * time.Second},
		{name: "RFC3339 reset", headers: SafeResponseHeaders{AnthropicRateLimitRequestsReset: now.Add(90 * time.Second).Format(time.RFC3339)}, want: 90 * time.Second},
		{name: "earliest allowlisted reset", headers: SafeResponseHeaders{RetryAfter: "30", RateLimitResetTokens: "2s"}, want: 2 * time.Second},
		{name: "cap", headers: SafeResponseHeaders{RetryAfter: "172800"}, want: maxProviderRetryDelay},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := parseResponseRetryAfter(tc.headers, now); got != tc.want {
				t.Fatalf("retry delay = %s, want %s", got, tc.want)
			}
		})
	}
}

func TestClassifiedResponseSummaryDoesNotEchoProviderBody(t *testing.T) {
	t.Parallel()
	secret := "credential-sentinel prompt-sentinel proxy-password-sentinel"
	got := ClassifyResponseEvidence(NewResponseEvidence(http.StatusForbidden, nil, []byte(`{"error":{"code":"content_policy","message":"`+secret+`"}}`)))
	if strings.Contains(got.Message, secret) || strings.Contains(got.Code, secret) || strings.Contains(got.Message, "sentinel") {
		t.Fatalf("classification leaked provider body: %#v", got)
	}
}
