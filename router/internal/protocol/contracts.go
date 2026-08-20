package protocol

import "net/http"

// Surface identifies the client-facing protocol surface.
type Surface string

const (
	SurfaceOpenAIChat      Surface = "openai-chat"
	SurfaceOpenAIResponses Surface = "openai-responses"
	SurfaceAnthropic       Surface = "anthropic-messages"
	SurfaceGemini          Surface = "gemini-generate-content"
	SurfaceImages          Surface = "images"
	SurfaceWebSearch       Surface = "web-search"
)

// Protocol is retained as the historical name for a client-facing surface.
// New domain contracts should use Surface.
type Protocol = Surface

const (
	ProtocolOpenAIChat     Protocol = SurfaceOpenAIChat
	ProtocolOpenAIResponse Protocol = SurfaceOpenAIResponses
	ProtocolAnthropic      Protocol = SurfaceAnthropic
	ProtocolGemini         Protocol = SurfaceGemini
)

// AllSurfaces returns every supported client-facing surface in stable order.
func AllSurfaces() []Surface {
	return []Surface{
		SurfaceOpenAIChat,
		SurfaceOpenAIResponses,
		SurfaceAnthropic,
		SurfaceGemini,
		SurfaceImages,
		SurfaceWebSearch,
	}
}

// IsValid reports whether the surface is supported by the canonical contract.
func (s Surface) IsValid() bool {
	switch s {
	case SurfaceOpenAIChat, SurfaceOpenAIResponses, SurfaceAnthropic, SurfaceGemini,
		SurfaceImages, SurfaceWebSearch:
		return true
	default:
		return false
	}
}

// Request is the normalized request envelope passed through the proxy path.
type Request struct {
	Protocol          Protocol
	// Operation is the endpoint/body-authoritative compatibility operation:
	// generate, compact V1, or compact V2. It is kept numeric here to avoid a
	// protocol-contract import cycle; transforms owns the typed alias.
	Operation          uint8
	Model             string
	Headers           http.Header
	Body              []byte
	Stream            bool
	ContinuationScope string
}

// Response is the normalized non-streaming proxy result.
type Response struct {
	StatusCode int
	Headers    http.Header
	Body       []byte
}

type Account struct {
	ID            string
	Provider      string
	Model         string
	CredentialRef CredentialRef
	Enabled       bool
	// Redacted identity metadata is optional and safe for admin/routing
	// projections. Secret material and provider responses never enter here.
	Email             string
	Name              string
	ProviderAccountID string
	OrgID             string
	OrgName           string
	ProjectID         string
	Region            string
	ReauthRequired    bool
}

// ErrorKind classifies failures for retry and account health decisions.
type ErrorKind string

const (
	ErrorInvalidRequest           ErrorKind = "invalid_request"
	ErrorUnsupported              ErrorKind = "unsupported"
	ErrorTranslation              ErrorKind = "translation"
	ErrorEntitlement              ErrorKind = "entitlement"
	ErrorContentPolicy            ErrorKind = "content_policy"
	ErrorReauthenticationRequired ErrorKind = "reauthentication_required"
	ErrorCapacity                 ErrorKind = "capacity"
	ErrorEmptyOutput              ErrorKind = "empty_output"
	ErrorAuthentication           ErrorKind = "authentication"
	ErrorRateLimit                ErrorKind = "rate_limit"
	ErrorQuota                    ErrorKind = "quota"
	ErrorTransient                ErrorKind = "transient"
	ErrorServerError              ErrorKind = "server_error"
	ErrorFatal                    ErrorKind = "fatal"
)

// RateSource identifies the bounded source of a rate or allowance decision.
// These values intentionally mirror the observability contract without
// importing it (the proxy contracts package is lower in the dependency graph).
type RateSource string

const (
	RateSourceLocalRateLimit   RateSource = "local_rate_limit"
	RateSourceLocalConcurrency RateSource = "local_concurrency_limit"
	RateSourceProviderRate     RateSource = "provider_rate_limit"
	RateSourceProviderQuota    RateSource = "provider_quota_exhausted"
	RateSourceAllowedTokens    RateSource = "allowed_tokens_exhausted"
	RateSourceAccountQuota     RateSource = "account_quota_exhausted"
	RateSourceCoordination     RateSource = "coordination_unavailable"
)

// RateScope identifies the bounded scope at which a limit applies.
type RateScope string

const (
	RateScopeClient       RateScope = "client"
	RateScopeIP           RateScope = "ip_security_identity"
	RateScopeRoute        RateScope = "route"
	RateScopeProvider     RateScope = "provider"
	RateScopeProxy        RateScope = "proxy"
	RateScopeModel        RateScope = "model"
	RateScopeAccount      RateScope = "account"
	RateScopeAPIKey       RateScope = "api_key"
	RateScopeOrganization RateScope = "organization"
	RateScopeGlobal       RateScope = "global_daemon"
)

// RatePhase identifies whether the decision occurred before dispatch, at the
// provider, or after partial work.
type RatePhase string

const (
	RatePhasePreDispatch RatePhase = "pre_dispatch"
	RatePhaseProvider    RatePhase = "provider"
	RatePhasePartialWork RatePhase = "partial_work"
)

func (s RateSource) IsValid() bool {
	switch s {
	case RateSourceLocalRateLimit, RateSourceLocalConcurrency, RateSourceProviderRate,
		RateSourceProviderQuota, RateSourceAllowedTokens, RateSourceAccountQuota,
		RateSourceCoordination:
		return true
	default:
		return false
	}
}

func (s RateScope) IsValid() bool {
	switch s {
	case RateScopeClient, RateScopeIP, RateScopeRoute, RateScopeProvider, RateScopeProxy,
		RateScopeModel, RateScopeAccount, RateScopeAPIKey, RateScopeOrganization,
		RateScopeGlobal:
		return true
	default:
		return false
	}
}

func (p RatePhase) IsValid() bool {
	switch p {
	case RatePhasePreDispatch, RatePhaseProvider, RatePhasePartialWork:
		return true
	default:
		return false
	}
}

// RouteError carries retry classification and upstream status information.
// Err remains internal and must never be serialized by API adapters.
type RouteError struct {
	Kind                     ErrorKind
	StatusCode               int
	Provider                 string
	Model                    string
	Code                     string
	Message                  string
	Retryable                bool
	RetryAfterMS             int64
	AlternateAccountEligible bool
	RateSource               RateSource
	RateScope                RateScope
	RatePhase                RatePhase
	// Phase and Scope are additive typed decision metadata. The Rate* fields
	// remain canonical for existing lifecycle consumers.
	Phase RatePhase
	Scope RateScope
	Err   error
}

// CodeString returns the stable route code, when one is available.
func (e *RouteError) CodeString() string {
	if e == nil {
		return ""
	}
	return e.Code
}

// Error implements error. Wrapped causes remain available through Unwrap but
// are not rendered because upstream text may contain secrets or raw bodies.
func (e *RouteError) Error() string {
	if e == nil {
		return "<nil>"
	}
	return e.Message
}

// Unwrap exposes the underlying error.
func (e *RouteError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// LifecycleEvidence exposes bounded retry/rate metadata to adapters without
// exposing the wrapped cause or any provider payload.
func (e *RouteError) LifecycleEvidence() (code string, retryable bool, retryAfterMS int64, alternate bool, source, scope, phase string) {
	if e == nil {
		return "", false, 0, false, "", "", ""
	}
	source, scope, phase = string(e.RateSource), string(e.RateScope), string(e.RatePhase)
	if scope == "" {
		scope = string(e.Scope)
	}
	if phase == "" {
		phase = string(e.Phase)
	}
	return e.Code, e.Retryable, e.RetryAfterMS, e.AlternateAccountEligible, source, scope, phase
}
