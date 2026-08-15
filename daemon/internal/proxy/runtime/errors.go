// Package proxy provides the Cartethyia hot-path: account pool, retry router,
// provider/credential/network selectors, request sanitization, and
// disconnect-aware stream helpers.
package proxy

// File: errors.go
import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// FailureKind extends contracts.ErrorKind with orchestrator-internal values
// that are never exposed on the wire. The zero value (unclassified) is
// intentionally invalid so callers must always set an explicit kind.
type FailureKind string

const (
	// FailureInvalidRequest: 4xx that is not auth/quota/rate-limit; never retry.
	FailureInvalidRequest FailureKind = "invalid_request"
	// FailureUnsupported is a valid request that the selected surface/provider cannot serve.
	FailureUnsupported FailureKind = "unsupported"
	// FailureTranslation is a canonical translation or protocol mapping failure.
	FailureTranslation FailureKind = "translation"
	// FailureEntitlement is a valid credential without route entitlement.
	FailureEntitlement FailureKind = "entitlement"
	// FailureContentPolicy is a provider policy refusal and must remain request-scoped.
	FailureContentPolicy FailureKind = "content_policy"
	// FailureReauthenticationRequired is a definitive credential lifecycle failure.
	FailureReauthenticationRequired FailureKind = "reauthentication_required"
	// FailureCapacity is a provider/model capacity failure eligible for bounded failover.
	FailureCapacity FailureKind = "capacity"
	// FailureEmptyOutput is an accepted response with no usable semantic output.
	FailureEmptyOutput FailureKind = "empty_output"
	// FailureAuthentication: credential rejected by upstream; refresh-eligible.
	FailureAuthentication FailureKind = "authentication"
	// FailureRateLimit: 429 / provider rate-limit; transient, retry with backoff.
	FailureRateLimit FailureKind = "rate_limit"
	// FailureQuota: account quota exhausted; do not retry until reset.
	FailureQuota FailureKind = "quota"
	// FailureTransient: transport hiccup; retry without poisoning the account.
	FailureTransient FailureKind = "transient"
	// FailureServerError is an explicit provider-side server failure.
	FailureServerError FailureKind = "server_error"
	// FailureFatal: non-recoverable upstream or protocol error; poison the account.
	FailureFatal FailureKind = "fatal"
	// FailureAborted: caller cancelled the request before completion.
	FailureAborted FailureKind = "aborted"
	// FailureUnknown: classification could not be determined; treated as fatal
	// by the router so the caller surfaces a 502 rather than a silent retry.
	FailureUnknown FailureKind = "unknown"
)

// Compatibility aliases used by callers that name these outcomes directly.
const (
	FailureCanceled   FailureKind = FailureAborted
	FailureValidation FailureKind = FailureInvalidRequest
)

// IsValid reports whether k is one of the declared classification values.
func (k FailureKind) IsValid() bool {
	switch k {
	case FailureInvalidRequest, FailureUnsupported, FailureTranslation,
		FailureEntitlement, FailureContentPolicy, FailureReauthenticationRequired,
		FailureCapacity, FailureEmptyOutput, FailureAuthentication, FailureRateLimit,
		FailureQuota, FailureTransient, FailureServerError, FailureFatal,
		FailureAborted, FailureUnknown:
		return true
	}
	return false
}

// FailurePhase and FailureScope are aliases for the lower-level bounded
// routing dimensions. They keep the typed coordinator API compatible with
// contracts.RouteError without creating a second taxonomy.
type FailurePhase = contracts.RatePhase
type FailureScope = contracts.RateScope

const (
	FailurePhasePreDispatch = contracts.RatePhasePreDispatch
	FailurePhaseProvider    = contracts.RatePhaseProvider
	FailurePhasePartialWork = contracts.RatePhasePartialWork
)

// RetryPolicy describes how the router should treat a FailureKind.
type RetryPolicy string

const (
	// RetryNever: stop the retry loop and surface the error to the caller.
	RetryNever RetryPolicy = "never"
	// RetryImmediate: try the next account in the same router attempt.
	RetryImmediate RetryPolicy = "immediate"
	// RetryBackoff: wait then try the next account.
	RetryBackoff RetryPolicy = "backoff"
	// RetryRefresh: trigger a credential refresh before retrying.
	RetryRefresh RetryPolicy = "refresh"
)

// RetryPolicyFor returns the deterministic retry behaviour for a failure kind.
// The legacy policy values remain stable; the coordinator additionally uses
// AlternateAccountEligible to express quota/auth failover without changing
// existing callers' RetryPolicy expectations.
func RetryPolicyFor(k FailureKind) RetryPolicy {
	switch k {
	case FailureInvalidRequest, FailureUnsupported, FailureTranslation,
		FailureEntitlement, FailureContentPolicy, FailureQuota, FailureAborted,
		FailureReauthenticationRequired:
		return RetryNever
	case FailureAuthentication:
		return RetryRefresh
	case FailureRateLimit:
		return RetryBackoff
	case FailureCapacity, FailureEmptyOutput, FailureTransient, FailureServerError:
		return RetryImmediate
	default:
		return RetryNever
	}
}

// PoisonAccount reports whether the router should mark the candidate account
// unhealthy after observing a failure of this kind.
func PoisonAccount(k FailureKind) bool {
	switch k {
	case FailureAuthentication, FailureReauthenticationRequired, FailureEntitlement,
		FailureQuota, FailureCapacity, FailureEmptyOutput, FailureFatal, FailureUnknown:
		return true
	default:
		return false
	}
}

// failureSignals captures the inputs that drive Classify. It is intentionally
// narrow: providers and transports pass only what they know without leaking
// raw upstream payloads or secrets.
type failureSignals struct {
	statusCode   int
	headerValues []string
	bodyPeek     string
	kind         FailureKind
	err          error
}

// ClassifyInput is the constructor-agnostic input for Classify.
type ClassifyInput struct {
	// StatusCode is the upstream HTTP status (0 when transport-level).
	StatusCode int
	// HeaderValues are header strings that mention rate-limit / quota signals
	// (e.g. "Retry-After: 30"). Only the values themselves are inspected; the
	// caller is responsible for keeping them secret-free.
	HeaderValues []string
	// BodyPeek is a bounded substring of the upstream body (≤ 512 bytes).
	// Classify never reads more than this; it only inspects it for known
	// sentinel phrases such as "rate_limit_exceeded".
	BodyPeek string
	// Kind is a hint set by the caller when it already knows the family
	// (e.g. context.Canceled). Empty means "let Classify decide".
	Kind FailureKind
	// Err is the raw transport or provider error. Unwrap-friendly.
	Err error
}

// Failure carries the classified error and upstream status, ready for router
// and pool consumption. Decision metadata is bounded and secret-free.
type Failure struct {
	Kind                     FailureKind
	StatusCode               int
	Provider                 string
	Model                    string
	Code                     string
	Message                  string
	Policy                   RetryPolicy
	Poison                   bool
	Retryable                bool
	RetryAfterMS             int64
	AlternateAccountEligible bool
	RateSource               contracts.RateSource
	RateScope                contracts.RateScope
	RatePhase                contracts.RatePhase
	// Phase and Scope are typed coordinator metadata. RatePhase/RateScope are
	// retained above for compatibility with existing lifecycle consumers.
	Phase FailurePhase
	Scope FailureScope
	Err   error
}

// CodeString returns the stable machine-readable failure code.
func (f *Failure) CodeString() string {
	if f == nil {
		return ""
	}
	return f.Code
}

// LifecycleEvidence exposes only bounded decision metadata to API adapters.
func (f *Failure) LifecycleEvidence() (code string, retryable bool, retryAfterMS int64, alternate bool, source, scope, phase string) {
	if f == nil {
		return "", false, 0, false, "", "", ""
	}
	return f.Code, f.Retryable, f.RetryAfterMS, f.AlternateAccountEligible, string(f.RateSource), string(f.RateScope), string(f.RatePhase)
}

// Error implements error. Only the bounded classification is returned; the
// wrapped cause remains available through Unwrap for internal matching and is
// never copied into operator logs or API messages.
func (f *Failure) Error() string {
	if f == nil {
		return "<nil>"
	}
	return f.Message
}

// Unwrap exposes the underlying error so errors.Is / errors.As work.
func (f *Failure) Unwrap() error { return f.Err }

// Classify deterministically maps the supplied signals to a Failure. The
// result is always populated with a valid FailureKind and Policy.
//
// Determinism rules (in order):
//  1. If Err is context.Canceled / DeadlineExceeded / AbortErr → FailureAborted.
//  2. If Kind hint is set and IsValid → keep it, recompute Policy.
//  3. Status-driven rules for 401/403, 408, 429, 5xx.
//  4. Header / body signal rules (e.g. "rate_limit_exceeded", "quota").
//  5. Fallback: FailureFatal for unknown 4xx, FailureUnknown for status 0.
func Classify(in ClassifyInput) (result *Failure) {
	defer func() { result = decorateFailure(result, in) }()
	if in.Err != nil {
		if errors.Is(in.Err, context.Canceled) || errors.Is(in.Err, context.DeadlineExceeded) {
			return &Failure{
				Kind:       FailureAborted,
				StatusCode: in.StatusCode,
				Policy:     RetryNever,
				Message:    "request aborted",
				Err:        in.Err,
			}
		}
		if errors.Is(in.Err, ErrAbort) {
			return &Failure{
				Kind:       FailureAborted,
				StatusCode: in.StatusCode,
				Policy:     RetryNever,
				Message:    "upstream aborted",
				Err:        in.Err,
			}
		}
	}

	if in.Kind != "" && in.Kind.IsValid() {
		return &Failure{
			Kind:       in.Kind,
			StatusCode: in.StatusCode,
			Policy:     RetryPolicyFor(in.Kind),
			Poison:     PoisonAccount(in.Kind),
			Message:    messageFor(in.Kind, in.StatusCode),
			Err:        in.Err,
		}
	}

	// Body/header evidence is evaluated before generic status. Providers often
	// wrap quota, capacity, or policy outcomes in 400/403/429/5xx responses.
	if sig := detectBodySignal(in.HeaderValues, in.BodyPeek); sig != "" {
		k := classifySignal(sig)
		return &Failure{
			Kind:       k,
			StatusCode: in.StatusCode,
			Policy:     RetryPolicyFor(k),
			Poison:     PoisonAccount(k),
			Message:    messageFor(k, in.StatusCode),
			Err:        in.Err,
		}
	}

	switch {
	case in.StatusCode == http.StatusUnauthorized || in.StatusCode == http.StatusForbidden:
		return &Failure{
			Kind:       FailureAuthentication,
			StatusCode: in.StatusCode,
			Policy:     RetryRefresh,
			Poison:     in.StatusCode != http.StatusForbidden,
			Message:    messageFor(FailureAuthentication, in.StatusCode),
			Err:        in.Err,
		}
	case in.StatusCode == http.StatusRequestTimeout:
		return &Failure{
			Kind:       FailureTransient,
			StatusCode: in.StatusCode,
			Policy:     RetryImmediate,
			Message:    "upstream request timeout",
			Err:        in.Err,
		}
	case in.StatusCode == http.StatusTooManyRequests:
		return &Failure{
			Kind:       FailureRateLimit,
			StatusCode: in.StatusCode,
			Policy:     RetryBackoff,
			Message:    "upstream rate limited",
			Err:        in.Err,
		}
	case in.StatusCode >= 500 && in.StatusCode <= 599:
		return &Failure{
			Kind:       FailureTransient,
			StatusCode: in.StatusCode,
			Policy:     RetryImmediate,
			Message:    "upstream server error",
			Err:        in.Err,
		}
	case in.StatusCode >= 400 && in.StatusCode <= 499:
		// Any other 4xx is invalid request from the caller's perspective.
		return &Failure{
			Kind:       FailureInvalidRequest,
			StatusCode: in.StatusCode,
			Policy:     RetryNever,
			Message:    messageFor(FailureInvalidRequest, in.StatusCode),
			Err:        in.Err,
		}
	}

	if in.StatusCode == 0 {
		return &Failure{
			Kind:       FailureUnknown,
			StatusCode: 0,
			Policy:     RetryNever,
			Poison:     true,
			Message:    "unclassified transport failure",
			Err:        in.Err,
		}
	}

	return &Failure{
		Kind:       FailureFatal,
		StatusCode: in.StatusCode,
		Policy:     RetryNever,
		Poison:     true,
		Message:    "upstream rejected the request",
		Err:        in.Err,
	}
}
func decorateFailure(f *Failure, in ClassifyInput) *Failure {
	if f == nil {
		return f
	}
	f.Retryable = f.Policy != RetryNever
	f.RetryAfterMS = parseRetryAfter(in.HeaderValues)
	f.RatePhase = contracts.RatePhaseProvider
	f.Phase = f.RatePhase
	switch f.Kind {
	case FailureRateLimit:
		f.RateSource = contracts.RateSourceProviderRate
		f.RateScope = contracts.RateScopeProvider
		f.AlternateAccountEligible = true
		f.Code = "provider.rate_limit"
	case FailureQuota:
		f.RateSource = contracts.RateSourceProviderQuota
		f.RateScope = contracts.RateScopeAccount
		f.AlternateAccountEligible = true
		f.Code = "provider.quota_exhausted"
	case FailureEntitlement:
		f.RateScope = contracts.RateScopeAccount
		f.Code = "provider.entitlement_denied"
	case FailureCapacity:
		f.RateScope = contracts.RateScopeModel
		f.AlternateAccountEligible = true
		f.Code = "provider.capacity"
	case FailureEmptyOutput:
		f.RateScope = contracts.RateScopeModel
		f.AlternateAccountEligible = true
		f.Code = "provider.empty_output"
	case FailureAuthentication:
		f.RateScope = contracts.RateScopeAccount
		f.Code = "provider.authentication_failed"
		if f.StatusCode != http.StatusForbidden {
			f.AlternateAccountEligible = true
		}
	case FailureReauthenticationRequired:
		f.RateScope = contracts.RateScopeAccount
		f.Code = "cartethyia.auth.refresh_required"
	case FailureContentPolicy:
		f.Code = "cartethyia.provider.content_policy"
		f.RateScope = contracts.RateScopeRoute
	case FailureUnsupported:
		f.Code = "cartethyia.request.unsupported"
		f.RatePhase = contracts.RatePhasePreDispatch
		f.RateScope = contracts.RateScopeRoute
	case FailureTranslation:
		f.Code = "cartethyia.translation.invalid"
		f.RatePhase = contracts.RatePhasePreDispatch
		f.RateScope = contracts.RateScopeRoute
	case FailureInvalidRequest:
		f.Code = "action.invalid_request"
		f.RatePhase = contracts.RatePhasePreDispatch
		f.RateScope = contracts.RateScopeRoute
	case FailureTransient:
		f.RateScope = contracts.RateScopeProvider
		f.Code = "provider.transient"
	case FailureServerError:
		f.RateScope = contracts.RateScopeProvider
		f.AlternateAccountEligible = true
		f.Code = "provider.server_error"
	case FailureAborted:
		f.Code = "action.cancelled"
		f.RatePhase = contracts.RatePhasePartialWork
		f.RateScope = contracts.RateScopeRoute
	case FailureFatal:
		f.Code = "provider.failed"
	default:
		f.Code = "provider.unknown"
	}
	f.Phase = f.RatePhase
	f.Scope = f.RateScope
	return f
}
func FromContracts(re *contracts.RouteError) *Failure {
	if re == nil {
		return Classify(ClassifyInput{})
	}
	kind := mapContractKind(re.Kind)
	policy := RetryNever
	if re.Retryable {
		policy = RetryPolicyFor(kind)
	}
	f := &Failure{
		Kind:                     kind,
		StatusCode:               re.StatusCode,
		Policy:                   policy,
		Poison:                   PoisonAccount(kind) && (re.Scope == contracts.RateScopeAccount || re.Scope == contracts.RateScopeModel || re.RateScope == contracts.RateScopeAccount || re.RateScope == contracts.RateScopeModel),
		Provider:                 re.Provider,
		Model:                    re.Model,
		Code:                     re.Code,
		Message:                  re.Message,
		Retryable:                re.Retryable,
		RetryAfterMS:             re.RetryAfterMS,
		AlternateAccountEligible: re.AlternateAccountEligible,
		RateSource:               re.RateSource,
		RateScope:                re.RateScope,
		RatePhase:                re.RatePhase,
		Phase:                    re.Phase,
		Scope:                    re.Scope,
		Err:                      re.Err,
	}
	if f.Scope == "" {
		f.Scope = f.RateScope
	}
	if f.RateScope == "" {
		f.RateScope = f.Scope
	}
	if f.Phase == "" {
		f.Phase = f.RatePhase
	}
	if f.RatePhase == "" {
		f.RatePhase = f.Phase
	}
	if f.Code == "" || f.Scope == "" || f.Phase == "" {
		defaults := decorateFailure(&Failure{Kind: kind, StatusCode: re.StatusCode, Policy: policy}, ClassifyInput{})
		if f.Code == "" {
			f.Code = defaults.Code
		}
		if f.Scope == "" {
			f.Scope, f.RateScope = defaults.Scope, defaults.RateScope
		}
		if f.Phase == "" {
			f.Phase, f.RatePhase = defaults.Phase, defaults.RatePhase
		}
		if f.RateSource == "" {
			f.RateSource = defaults.RateSource
		}
	}
	if f.Message == "" {
		f.Message = messageFor(kind, re.StatusCode)
	}
	return f
}

func mapContractKind(k contracts.ErrorKind) FailureKind {
	switch k {
	case contracts.ErrorInvalidRequest:
		return FailureInvalidRequest
	case contracts.ErrorUnsupported:
		return FailureUnsupported
	case contracts.ErrorTranslation:
		return FailureTranslation
	case contracts.ErrorEntitlement:
		return FailureEntitlement
	case contracts.ErrorContentPolicy:
		return FailureContentPolicy
	case contracts.ErrorReauthenticationRequired:
		return FailureReauthenticationRequired
	case contracts.ErrorCapacity:
		return FailureCapacity
	case contracts.ErrorEmptyOutput:
		return FailureEmptyOutput
	case contracts.ErrorAuthentication:
		return FailureAuthentication
	case contracts.ErrorRateLimit:
		return FailureRateLimit
	case contracts.ErrorQuota:
		return FailureQuota
	case contracts.ErrorTransient:
		return FailureTransient
	case contracts.ErrorServerError:
		return FailureServerError
	case contracts.ErrorFatal:
		return FailureFatal
	default:
		return FailureUnknown
	}
}

// detectBodySignal scans header values and the body peek for known sentinel
// phrases. It returns the matched phrase (lower-case) or "" when nothing
// matched. Inputs are bounded by the caller.
func detectBodySignal(headers []string, body string) string {
	for _, h := range headers {
		low := strings.ToLower(h)
		for _, sig := range knownSignals {
			if strings.Contains(low, sig) {
				return sig
			}
		}
	}
	if body == "" {
		return ""
	}
	low := strings.ToLower(body)
	for _, sig := range knownSignals {
		if strings.Contains(low, sig) {
			return sig
		}
	}
	return ""
}

func classifySignal(sig string) FailureKind {
	switch sig {
	case "rate_limit", "rate-limit", "rate_limit_exceeded", "ratelimited",
		"too_many_requests", "slow_down":
		return FailureRateLimit
	case "quota", "quota_exceeded", "insufficient_quota", "usage_limit",
		"free_usage_exhausted", "billing_quota":
		return FailureQuota
	case "capacity", "model_capacity", "overloaded", "temporarily_unavailable":
		return FailureCapacity
	case "content_policy", "content-policy", "safety_violation",
		"policy_violation", "content_filter":
		return FailureContentPolicy
	case "unauthorized", "invalid_api_key", "authentication_failed":
		return FailureAuthentication
	case "invalid_grant", "revoked", "reauthentication_required":
		return FailureReauthenticationRequired
	case "unsupported", "not_supported":
		return FailureUnsupported
	case "translation", "invalid_translation":
		return FailureTranslation
	case "context_length_exceeded", "context_overflow":
		return FailureFatal
	default:
		return FailureUnknown
	}
}

func messageFor(k FailureKind, status int) string {
	switch k {
	case FailureInvalidRequest:
		return "invalid request"
	case FailureUnsupported:
		return "unsupported request"
	case FailureTranslation:
		return "translation failed"
	case FailureEntitlement:
		return "provider entitlement denied"
	case FailureContentPolicy:
		return "provider content policy refusal"
	case FailureReauthenticationRequired:
		return "reauthentication required"
	case FailureCapacity:
		return "provider at capacity"
	case FailureEmptyOutput:
		return "provider returned empty output"
	case FailureAuthentication:
		return "authentication failed"
	case FailureRateLimit:
		return "rate limited"
	case FailureQuota:
		return "quota exhausted"
	case FailureTransient:
		return "transient upstream error"
	case FailureServerError:
		return "provider server error"
	case FailureFatal:
		return "upstream rejected the request"
	case FailureAborted:
		return "request aborted"
	default:
		return "unclassified failure"
	}
}
func parseRetryAfter(values []string) int64 {
	for _, value := range values {
		lower := strings.ToLower(strings.TrimSpace(value))
		if !strings.HasPrefix(lower, "retry-after:") {
			continue
		}
		raw := strings.TrimSpace(lower[len("retry-after:"):])
		seconds := 0
		for _, ch := range raw {
			if ch < '0' || ch > '9' {
				seconds = 0
				break
			}
			seconds = seconds*10 + int(ch-'0')
			if seconds > 86400 {
				seconds = 86400
				break
			}
		}
		if seconds > 0 {
			return int64(seconds) * 1000
		}
	}
	return 0
}

var knownSignals = []string{
	"rate_limit",
	"rate-limit",
	"rate_limit_exceeded",
	"ratelimited",
	"too_many_requests",
	"slow_down",
	"quota",
	"quota_exceeded",
	"insufficient_quota",
	"usage_limit",
	"free_usage_exhausted",
	"billing_quota",
	"capacity",
	"model_capacity",
	"overloaded",
	"temporarily_unavailable",
	"content_policy",
	"content-policy",
	"safety_violation",
	"policy_violation",
	"content_filter",
	"unauthorized",
	"invalid_api_key",
	"authentication_failed",
	"invalid_grant",
	"reauthentication_required",
	"revoked",
	"unsupported",
	"not_supported",
	"translation",
	"invalid_translation",
	"context_length_exceeded",
	"context_overflow",
}

// ErrAbort is a sentinel returned by upstream callers that intentionally
// cancelled an in-flight request. It maps to FailureAborted.
var ErrAbort = errors.New("proxy: aborted")
