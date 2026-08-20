package telemetry

import "strings"

type LifecycleKey string

// LifecycleKey is the translated, stable event name used by action evidence.
// Keys are bounded constants; callers must not use arbitrary user/provider text.
const (
	EventIncomingRequest       LifecycleKey = "incoming_request"
	EventRouteSelected         LifecycleKey = "route_selected"
	EventProviderAttempt       LifecycleKey = "provider_attempt"
	EventRequestSucceeded      LifecycleKey = "request_succeeded"
	EventRequestFailed         LifecycleKey = "request_failed"
	EventRequestRetried        LifecycleKey = "request_retried"
	EventRequestFallback       LifecycleKey = "request_fallback"
	EventTokenRefreshStarted   LifecycleKey = "token_refresh_started"
	EventTokenRefreshSucceeded LifecycleKey = "token_refresh_succeeded"
	EventTokenRefreshTransient LifecycleKey = "token_refresh_transient"
	EventTokenRefreshReauth    LifecycleKey = "token_refresh_reauthentication_required"
	EventTokenRefreshFailed    LifecycleKey = "token_refresh_failed"
	EventOAuthStarted          LifecycleKey = "oauth_started"
	EventOAuthPending          LifecycleKey = "oauth_pending"
	EventOAuthCompleted        LifecycleKey = "oauth_completed"
	EventOAuthCancelled        LifecycleKey = "oauth_cancelled"
	EventOAuthExpired          LifecycleKey = "oauth_expired"
	EventOAuthDenied           LifecycleKey = "oauth_denied"
	EventRequestCancelled      LifecycleKey = "request_cancelled"
	EventRequestCompleted      LifecycleKey = "request_completed"
)

func (k LifecycleKey) IsValid() bool {
	switch k {
	case EventIncomingRequest, EventRouteSelected, EventProviderAttempt,
		EventRequestSucceeded, EventRequestFailed, EventRequestRetried,
		EventRequestFallback, EventTokenRefreshStarted, EventTokenRefreshSucceeded,
		EventTokenRefreshTransient, EventTokenRefreshReauth, EventTokenRefreshFailed,
		EventOAuthStarted, EventOAuthPending, EventOAuthCompleted,
		EventOAuthCancelled, EventOAuthExpired, EventOAuthDenied,
		EventRequestCancelled, EventRequestCompleted:
		return true
	default:
		return false
	}
}

// RateSource distinguishes local admission, provider, allowance, and
// coordination failures. Values are safe for metric labels and API DTOs.
type RateSource string

const (
	RateSourceLocalRateLimit    RateSource = "local_rate_limit"
	RateSourceLocalConcurrency  RateSource = "local_concurrency_limit"
	RateSourceProviderRateLimit RateSource = "provider_rate_limit"
	RateSourceProviderQuota     RateSource = "provider_quota_exhausted"
	RateSourceAllowedTokens     RateSource = "allowed_tokens_exhausted"
	RateSourceAccountQuota      RateSource = "account_quota_exhausted"
	RateSourceCoordination      RateSource = "coordination_unavailable"
)

func (s RateSource) IsValid() bool {
	switch s {
	case RateSourceLocalRateLimit, RateSourceLocalConcurrency,
		RateSourceProviderRateLimit, RateSourceProviderQuota,
		RateSourceAllowedTokens, RateSourceAccountQuota, RateSourceCoordination:
		return true
	default:
		return false
	}
}

// RateScope identifies the bounded identity at which an allowance applies.
type RateScope string

const (
	RateScopeClient       RateScope = "client"
	RateScopeIP           RateScope = "ip_security_identity"
	RateScopeRoute        RateScope = "route"
	RateScopeProvider     RateScope = "provider"
	RateScopeModel        RateScope = "model"
	RateScopeAccount      RateScope = "account"
	RateScopeAPIKey       RateScope = "api_key"
	RateScopeOrganization RateScope = "organization"
	RateScopeGlobal       RateScope = "global_daemon"
)

func (s RateScope) IsValid() bool {
	switch s {
	case RateScopeClient, RateScopeIP, RateScopeRoute, RateScopeProvider,
		RateScopeModel, RateScopeAccount, RateScopeAPIKey, RateScopeOrganization,
		RateScopeGlobal:
		return true
	default:
		return false
	}
}

// RatePhase records when a limit became observable.
type RatePhase string

const (
	RatePhasePreDispatch RatePhase = "pre_dispatch"
	RatePhaseProvider    RatePhase = "provider"
	RatePhasePartialWork RatePhase = "partial_work"
)

func (p RatePhase) IsValid() bool {
	switch p {
	case RatePhasePreDispatch, RatePhaseProvider, RatePhasePartialWork:
		return true
	default:
		return false
	}
}

// Stable lifecycle and rate codes. These are intentionally namespaced and
// specific: adapters must preserve them instead of replacing them with a
// generic rate_limited/quota/upstream_error value.
const (
	CodeIncoming              = "action.incoming"
	CodeRouteSelected         = "action.route_selected"
	CodeProviderAttempt       = "action.provider_attempt"
	CodeRequestSucceeded      = "action.succeeded"
	CodeRequestFailed         = "action.failed"
	CodeRequestRetried        = "action.retried"
	CodeRequestFallback       = "action.fallback"
	CodeTokenRefreshStarted   = "auth.refresh_started"
	CodeTokenRefreshSucceeded = "auth.refresh_succeeded"
	CodeTokenRefreshTransient = "auth.refresh_transient"
	CodeTokenRefreshReauth    = "auth.refresh_reauthentication_required"
	CodeTokenRefreshFailed    = "auth.refresh_failed"
	CodeRequestCancelled      = "action.cancelled"
	CodeRequestCompleted      = "action.completed"
	CodeAdmissionLocalRate    = "admission.local_rate_limit"
	CodeAdmissionConcurrency  = "admission.local_concurrency_limit"
	CodeProviderRate          = "provider.rate_limit"
	CodeProviderQuota         = "provider.quota_exhausted"
	CodeAllowedTokens         = "quota.allowed_tokens_exhausted"
	CodeAccountQuota          = "quota.account_quota_exhausted"
	CodeCoordination          = "coordination.unavailable"
	CodeRetryEligible         = "action.retry_eligible"
	CodeRetryExhausted        = "action.retry_exhausted"
)

// CanonicalActionEvent is the operator-safe evidence contract for one action
// lifecycle emission. It contains identity and bounded decision metadata only;
// request bodies, credentials, provider responses, and token material cannot
// be represented.
type CanonicalActionEvent struct {
	Key                      LifecycleKey
	Code                     string
	RequestID                string
	TraceID                  string
	Origin                   string
	ClientFamily             string
	Method                   string
	Path                     string
	Provider                 string
	Model                    string
	Attempt                  int
	AccountID                string
	AccountEmail             string
	AccountName              string
	AccountDisplay           string
	ProxyID                  string
	ProxyName                string
	ProxyDisplay             string
	ProxySource              string
	RateSource               RateSource
	RateScope                RateScope
	RatePhase                RatePhase
	Retryable                bool
	RetryAfterMS             int64
	AlternateAccountEligible bool
	Outcome                  Outcome
	StartedAtUnix            int64
	EndedAtUnix              int64
	LatencyMS                int64
}

func ResolveAccountDisplay(email, configuredName, localID string) (display, source string) {
	if email = boundedIdentity(strings.ToLower(email)); email != "" {
		return email, "email"
	}
	if configuredName = boundedIdentity(configuredName); configuredName != "" {
		return configuredName, "configured"
	}
	return boundedIdentity(localID), "local_id"
}

// ResolveProxyDisplay applies configured name/label then local ID.
func ResolveProxyDisplay(configuredName, proxyID string) (display, source string) {
	if configuredName = boundedIdentity(configuredName); configuredName != "" {
		return configuredName, "configured"
	}
	return boundedIdentity(proxyID), "proxy_id"
}

func boundedIdentity(value string) string {
	value = trimASCIIWhitespace(value)
	if len(value) > MaxIdentifierLen {
		return value[:MaxIdentifierLen]
	}
	return value
}

func trimASCIIWhitespace(value string) string {
	start, end := 0, len(value)
	for start < end && (value[start] == ' ' || value[start] == '\t' || value[start] == '\r' || value[start] == '\n') {
		start++
	}
	for end > start && (value[end-1] == ' ' || value[end-1] == '\t' || value[end-1] == '\r' || value[end-1] == '\n') {
		end--
	}
	return value[start:end]
}
