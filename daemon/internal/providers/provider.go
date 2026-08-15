// Package providers defines the provider abstraction used by Cartethyia to
// route a normalized client request to a concrete upstream.
//
// A Provider owns:
//   - Identity metadata (id, display name, wire protocol, accepted credentials).
//   - Capability metadata (which wire surfaces it speaks, streaming, tools, etc.).
//   - Model catalog entries (declared models plus per-model capability overrides).
//   - Endpoint selection (which URL path the wire protocol maps to).
//   - Authentication material construction (headers, query, or body credentials).
//   - Request construction (translating a normalized proxy body into the
//     wire-format payload the upstream expects).
//   - Response classification (mapping a raw upstream response into the
//     normalized routing result).
//
// The Provider itself does not perform network I/O: it builds the bytes and
// metadata that a Transport will carry. This keeps each adapter testable in
// isolation and lets the runtime swap transports centrally.
package providers

import (
	"net/http"
	"strings"
	"time"

	domaincontracts "github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// Surface is the canonical client-facing protocol surface shared with the
// proxy contract package.
type Surface = domaincontracts.Surface

// FailureScope identifies the smallest health domain a provider response may
// update. It aliases the routing contract so adapters do not define a second
// scope taxonomy.
type FailureScope = domaincontracts.RateScope

const (
	FailureScopeRoute    = domaincontracts.RateScopeRoute
	FailureScopeProvider = domaincontracts.RateScopeProvider
	FailureScopeProxy    = domaincontracts.RateScopeProxy
	FailureScopeModel    = domaincontracts.RateScopeModel
	FailureScopeAccount  = domaincontracts.RateScopeAccount
)

const (
	// SurfaceOpenAIChat is the legacy OpenAI Chat Completions wire format.
	SurfaceOpenAIChat = domaincontracts.SurfaceOpenAIChat
	// SurfaceOpenAIResponses is the OpenAI Responses API wire format.
	SurfaceOpenAIResponses = domaincontracts.SurfaceOpenAIResponses
	// SurfaceAnthropicMessages is the Anthropic Messages wire format.
	SurfaceAnthropicMessages = domaincontracts.SurfaceAnthropic
	// SurfaceGemini is the native Gemini generate-content wire format.
	SurfaceGemini = domaincontracts.SurfaceGemini
	// SurfaceImages is the hosted image generation wire format.
	SurfaceImages = domaincontracts.SurfaceImages
	// SurfaceWebSearch is the native web-search tool surface.
	SurfaceWebSearch = domaincontracts.SurfaceWebSearch
)

// AllSurfaces lists every Surface value. Useful for validation.
func AllSurfaces() []Surface {
	return domaincontracts.AllSurfaces()
}

// Protocol names the wire protocol family a provider speaks on the wire. It
// is distinct from Surface, which is the protocol surfaced to the client:
// multiple Surfaces may share a single Protocol (e.g. openai-chat and
// openai-responses both flow through the openai Protocol).
type Protocol string

const (
	ProtocolOpenAI    Protocol = "openai"
	ProtocolAnthropic Protocol = "anthropic"
	ProtocolGemini    Protocol = "gemini"
	ProtocolExa       Protocol = "exa"
)

// CredentialKind classifies the credential a provider accepts.
type CredentialKind string

const (
	CredentialAPIKey CredentialKind = "api_key"
	CredentialOAuth  CredentialKind = "oauth"
	CredentialManual CredentialKind = "manual"
	CredentialNone   CredentialKind = "none"
)

// ProviderMeta is the identity and ownership record a Provider publishes to
// the registry. Endpoint and credential ownership live here; runtime code
// must not reconstruct provider-specific values from environment variables.
type ProviderMeta struct {
	ID              string
	DisplayName     string
	Protocol        Protocol
	CredentialKind  CredentialKind
	CredentialRef   string
	BaseURL         string
	CredentialURL   string
	CredentialKinds []CredentialKind
}

// ProviderCaps is the capability record a Provider publishes. Fields mirror
// the legacy ProviderCaps shape; only fields observable in the source
// providers are populated by the built-in adapters.
type ProviderCaps struct {
	// Surfaces is the set of Surfaces the provider can serve.
	Surfaces []Surface
	// Streaming reports whether the provider can deliver SSE responses.
	Streaming bool
	// Reasoning reports whether the provider understands reasoning blocks.
	Reasoning bool
	// ToolCalls reports whether the provider accepts tool definitions.
	ToolCalls bool
	// Images reports whether the provider accepts image inputs.
	Images bool
	// MediaGeneration is the set of media kinds the provider can synthesize.
	MediaGeneration []string
	// ExplicitCache reports whether the provider supports explicit
	// cache_control style cache hinting.
	ExplicitCache bool
	// PromptCacheKey reports whether the provider honors a prompt cache key.
	PromptCacheKey bool
	// Search reports whether the provider can execute a native web search.
	Search bool
	// Compatibility is the immutable, typed provider policy. A zero policy
	// retains the legacy boolean behavior through EffectiveCompatibilityPolicy.
	Compatibility CompatibilityPolicy
	// Policy is a compatibility alias for integrations that name the nested
	// record directly. Compatibility takes precedence when both are present.
	Policy CompatibilityPolicy
}

// ProviderModel is a single catalog entry.
type ProviderModel struct {
	// ID is the client-facing model identifier.
	ID string
	// DisplayName is the human-readable label.
	DisplayName string
	// Capabilities is the model-scoped capability record. When nil, the
	// Provider's aggregate Capabilities are used.
	Capabilities *ProviderCaps
	// UpstreamID is the identifier the upstream API actually receives. When
	// empty, ID is forwarded verbatim.
	UpstreamID string
	// Surfaces overrides the provider's Surfaces for this model only.
	Surfaces []Surface
	// Reasoning overrides the provider-level reasoning flag.
	Reasoning *bool
	// ToolCalls overrides the provider-level tool-call flag.
	ToolCalls *bool
	// ContextWindow and MaxOutput are handwritten fallback limits.
	ContextWindow int
	MaxOutput     int
	Pricing       *ModelPricing
	// ModelsDevProvider and ModelsDevModel select the exact enrichment record;
	// they may differ from the Cartethyia provider/model IDs.
	ModelsDevProvider string
	ModelsDevModel    string
	// Metadata contains source-backed model limits, pricing, modalities, and
	// reasoning details. Provider-specific overrides are applied by the
	// catalog loader before the model is exposed.
	Metadata ModelMetadata
	// Compatibility overrides provider policy for this model. It is copied when
	// a catalog snapshot is activated and must not be mutated afterward.
	Compatibility *CompatibilityPolicy
	// Policy is an alias of Compatibility for catalog sources using policy
	// terminology; Compatibility takes precedence when both are present.
	Policy *CompatibilityPolicy
}

// ModelMetadata is model-scoped information loaded from models.dev or a
// provider-owned override when the upstream model is not listed there.
type ModelMetadata struct {
	ContextWindow int
	MaxOutput     int
	Pricing       ModelPricing
	Modalities    ModelModalities
	Reasoning     ModelReasoning
	Source        string
}

// ModelPricing stores source pricing in USD per one million tokens.
type ModelPricing struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}

// ModelModalities describes model input and output media types.
type ModelModalities struct {
	Input  []string
	Output []string
}

// ModelReasoning describes whether and how a model exposes reasoning.
type ModelReasoning struct {
	Enabled bool
	Options []string
}

// ProviderModelCatalog is the read-only model catalog exposed by a Provider.
type ProviderModelCatalog interface {
	// List returns every catalog entry in declaration order.
	List() []ProviderModel
	// Get returns the entry for the client-facing model id, or nil when
	// the catalog has no entry for that id.
	Get(modelID string) *ProviderModel
}

// Model is a convenience constructor that returns a ProviderModel with the
// provided fields. Caps may be nil to mean "inherit from the provider".
func Model(id, displayName string, caps *ProviderCaps) ProviderModel {
	return ProviderModel{ID: id, DisplayName: displayName, Capabilities: caps}
}

// ModelWithUpstream is a convenience constructor for models whose upstream
// identifier differs from the client-facing id.
func ModelWithUpstream(id, upstreamID, displayName string, caps *ProviderCaps) ProviderModel {
	return ProviderModel{ID: id, UpstreamID: upstreamID, DisplayName: displayName, Capabilities: caps}
}

// ModelWithCompatibility constructs a model with an immutable policy override.
func ModelWithCompatibility(id, displayName string, caps *ProviderCaps, policy CompatibilityPolicy) ProviderModel {
	return ProviderModel{ID: id, DisplayName: displayName, Capabilities: caps, Compatibility: clonePolicyPtr(&policy)}
}

func ModelWithPolicy(id, displayName string, caps *ProviderCaps, policy CompatibilityPolicy) ProviderModel {
	return ModelWithCompatibility(id, displayName, caps, policy)
}

// Endpoint is the network address a built request should be sent to. The
// Provider publishes the path; the base URL is supplied by the runtime so
// adapters can be exercised against a local fixture in tests.
type Endpoint struct {
	// Method is the HTTP method the transport should use.
	Method string
	// Path is the path component appended to the provider's base URL.
	// Callers MUST NOT include a leading slash; the runtime joins with "/".
	Path string
	// Query carries any fixed query parameters the upstream requires.
	Query map[string]string
}

// AuthMaterial is the authentication header set a Provider attaches to a
// request before it leaves Cartethyia.
type AuthMaterial struct {
	// Headers is the header set to merge into the request. Values for
	// existing keys (Content-Type, Accept, etc.) take precedence.
	Headers http.Header
	// Query carries credential-bearing query parameters (rare).
	Query map[string]string
	// Cookie is the cookie payload, if the upstream uses session cookies.
	Cookie string
}

// BuiltRequest is the wire payload produced by a Provider for a single call.
// The transport sends the bytes and headers specified by the Provider.
// It MUST NOT add a Cartethyia User-Agent or any other product identity.
// Provider-specific identity headers are allowed only when required by the
// upstream contract.
type BuiltRequest struct {
	// Endpoint is the address the request is sent to.
	Endpoint Endpoint
	// Body is the wire-format payload, JSON-encoded by the adapter.
	Body []byte
	// Auth carries the credential-bearing headers and query parameters.
	Auth AuthMaterial
	// Stream reports whether the upstream should produce a streaming
	// response. Transports use this to flip Accept and select a streaming
	// reader.
	Stream bool
}

// ClassifiedResponse is the normalized outcome a Provider derives from a raw
// upstream response. The runtime re-classifies transport errors itself; this
// shape is for content-level decisions (status code meaning, body parsing).
const (
	// MaxResponseEvidenceBodyBytes bounds provider-owned marker inspection. The
	// transport may read a larger response for successful delivery, but a
	// classifier never receives more than this prefix.
	MaxResponseEvidenceBodyBytes = 16 << 10
	maxSafeResponseHeaderBytes   = 256
)

// SafeResponseHeaders contains only response timing headers that providers
// may use for retry classification. Arbitrary upstream headers, cookies, and
// credentials cannot enter classification evidence through this type.
type SafeResponseHeaders struct {
	RetryAfter                      string
	RateLimitReset                  string
	RateLimitResetRequests          string
	RateLimitResetTokens            string
	AnthropicRateLimitRequestsReset string
	AnthropicRateLimitTokensReset   string
}

// NewSafeResponseHeaders copies the allowlisted timing headers from headers.
// Invalid, control-bearing, or oversized values are discarded.
func NewSafeResponseHeaders(headers http.Header) SafeResponseHeaders {
	return SafeResponseHeaders{
		RetryAfter:                      safeResponseHeader(headers.Get("Retry-After")),
		RateLimitReset:                  safeResponseHeader(firstResponseHeader(headers, "RateLimit-Reset", "X-RateLimit-Reset")),
		RateLimitResetRequests:          safeResponseHeader(headers.Get("X-RateLimit-Reset-Requests")),
		RateLimitResetTokens:            safeResponseHeader(headers.Get("X-RateLimit-Reset-Tokens")),
		AnthropicRateLimitRequestsReset: safeResponseHeader(headers.Get("Anthropic-Ratelimit-Requests-Reset")),
		AnthropicRateLimitTokensReset:   safeResponseHeader(headers.Get("Anthropic-Ratelimit-Tokens-Reset")),
	}
}

func firstResponseHeader(headers http.Header, names ...string) string {
	for _, name := range names {
		if value := headers.Get(name); value != "" {
			return value
		}
	}
	return ""
}

func safeResponseHeader(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxSafeResponseHeaderBytes || strings.IndexFunc(value, func(r rune) bool {
		return r < 0x20 || r == 0x7f
	}) >= 0 {
		return ""
	}
	return value
}

// ResponseEvidence is the complete bounded input to provider classification.
// BodyPrefix is copied and capped by NewResponseEvidence; callers must use the
// constructor rather than retaining a raw upstream body.
type ResponseEvidence struct {
	StatusCode int
	Headers    SafeResponseHeaders
	BodyPrefix []byte
}

// NewResponseEvidence builds bounded, secret-safe classifier input.
func NewResponseEvidence(statusCode int, headers http.Header, body []byte) ResponseEvidence {
	if len(body) > MaxResponseEvidenceBodyBytes {
		body = body[:MaxResponseEvidenceBodyBytes]
	}
	return ResponseEvidence{
		StatusCode: statusCode,
		Headers:    NewSafeResponseHeaders(headers),
		BodyPrefix: append([]byte(nil), body...),
	}
}

type ClassifiedResponse struct {
	// StatusCode is the upstream HTTP status, when available.
	StatusCode int
	// Retryable reports whether the coordinator may perform any further action,
	// including a bounded credential refresh or an explicitly eligible alternate.
	Retryable bool
	// AlternateAccountEligible is an explicit provider decision. False means
	// stop after any category-specific same-account action; runtime code must
	// not infer alternate eligibility from Category.
	AlternateAccountEligible bool
	// Category groups the upstream response into a routing bucket. The
	// runtime uses the category to drive telemetry and health updates.
	Category ResponseCategory
	// Code is a stable machine-readable identifier owned by the classifier.
	Code string
	// RetryAfter is parsed only from allowlisted timing headers and capped.
	RetryAfter time.Duration
	// Phase and Scope identify where the failure occurred and the smallest
	// health domain that may be updated.
	Phase domaincontracts.RatePhase
	Scope domaincontracts.RateScope
	// Message is a bounded, secret-free summary surfaced in error bodies.
	Message string
}

// ResponseCategory groups raw upstream responses into routing buckets.
type ResponseCategory string

const (
	// CategorySuccess covers any 2xx response.
	CategorySuccess ResponseCategory = "success"
	// CategoryAuth covers credential rejections (401, 403).
	CategoryAuth ResponseCategory = "auth"
	// CategoryEntitlement covers an otherwise valid credential that cannot
	// access a provider/model/account entitlement. It is distinct from an
	// invalid credential so account policy can choose the correct scope.
	CategoryEntitlement ResponseCategory = "entitlement"
	// CategoryRateLimit covers 429 and explicit retry-after signals.
	CategoryRateLimit ResponseCategory = "rate_limit"
	// CategoryQuota covers usage / quota exhaustion.
	CategoryQuota ResponseCategory = "quota"
	// CategoryCapacity covers a temporarily unavailable model/backend.
	CategoryCapacity ResponseCategory = "capacity"
	// CategoryContentPolicy covers a provider content-policy refusal. It is
	// intentionally non-retryable and non-failover by default.
	CategoryContentPolicy ResponseCategory = "content_policy"
	// CategoryEmptyOutput covers a provider response with no usable output.
	CategoryEmptyOutput ResponseCategory = "empty_output"
	// CategoryInvalidRequest covers 4xx other than auth/rate/quota.
	CategoryInvalidRequest ResponseCategory = "invalid_request"
	// CategoryTransient covers 5xx and network failures.
	CategoryTransient ResponseCategory = "transient"
	// CategoryServerError distinguishes an explicit provider server failure
	// from a generic transient transport failure.
	CategoryServerError ResponseCategory = "server_error"
	// CategoryFatal covers protocol-level failures (empty body, malformed
	// JSON, unexpected content type) the router should not retry.
	CategoryFatal ResponseCategory = "fatal"
)

// RouteTarget is the resolved (provider, model, surface) triple a router
// hands to a Provider. It mirrors the legacy RouteTarget contract: the
// UpstreamModelID is the wire identifier the upstream actually expects.
type RouteTarget struct {
	// ProviderID matches the Provider that produced this target.
	ProviderID string
	// ModelID is the client-facing model identifier.
	ModelID string
	// UpstreamModelID is the identifier sent on the wire. Defaults to
	// ModelID when the catalog entry has no UpstreamID.
	UpstreamModelID string
	// Surface is the wire surface to use for the call.
	Surface Surface
}

// RequestEnvelope is the input a Provider receives when building a request.
// It intentionally mirrors only the fields a Provider needs: the runtime
// holds richer context (network selection, payload capture, telemetry) and
// passes them through Transports, not Providers.
type RequestEnvelope struct {
	// Target identifies the model and surface to call.
	Target RouteTarget
	// Body is the normalized proxy body, opaque to the Provider: each
	// adapter decodes it according to its own protocol.
	Body []byte
	// Stream asks the upstream to produce a streaming response.
	Stream bool
	// Headers are the original client headers. Providers may use them for
	// passthrough, but MUST NOT log or persist them.
	Headers http.Header
}

// RepairProposal is a provider-owned, deterministic replacement for a
// request body rejected by one allowlisted compatibility rule. RuleID is
// stable operational metadata; Body remains request-local and MUST NOT be
// logged, persisted, or included in errors or evidence.
type RepairProposal struct {
	RuleID string
	Body   []byte
}

// RepairProposer is the optional compatibility-repair boundary implemented
// only by providers with fixture-backed rules. RepairRule inspects bounded
// response evidence and returns a stable allowlisted rule identifier.
// ProposeRepair applies only that rule to the normalized request body and is
// side-effect free. Its bool reports that the rule and request were understood;
// the proposal may deliberately contain an unchanged body so the runtime can
// reject it and emit changed=false evidence. The runtime owns de-duplication,
// budgets, and replay.
type RepairProposer interface {
	RepairRule(evidence ResponseEvidence) string
	ProposeRepair(ruleID string, request RequestEnvelope) (RepairProposal, bool)
}

// Provider is the abstraction every adapter implements. The interface is
// deliberately small and side-effect free: a Provider is a pure function
// from a RequestEnvelope plus a credential to a BuiltRequest and a
// ClassifiedResponse strategy. Network I/O is owned by Transports, which the
// runtime wires in centrally.
type Provider interface {
	// Metadata returns the identity record. The result MUST be stable for
	// the lifetime of the Provider instance.
	Metadata() ProviderMeta
	// Capabilities returns the provider-level capability record.
	Capabilities() ProviderCaps
	// Models returns the read-only model catalog.
	Models() ProviderModelCatalog
	// ResolveTarget validates that the provider can serve (modelID, surface)
	// and returns the upstream model id and surface for routing. Implementers
	// MUST return an *UnknownSurfaceError or *UnknownModelError when the
	// surface or model is not supported.
	ResolveTarget(modelID string, surface Surface) (RouteTarget, error)
	// Endpoint returns the address a request for the given target should be
	// sent to. The base URL is supplied by the runtime.
	Endpoint(target RouteTarget) Endpoint
	// AuthMaterial constructs the credential-bearing headers for a call. The
	// credential argument is the secret retrieved by the storage layer; the
	// Provider MUST NOT log it.
	AuthMaterial(credential string, target RouteTarget) (AuthMaterial, error)
	// BuildRequest encodes the request envelope into a wire payload. The
	// returned bytes are sent verbatim by the transport.
	BuildRequest(envelope RequestEnvelope, credential string) (BuiltRequest, error)
	// ClassifyResponse maps bounded response evidence into a routing decision.
	ClassifyResponse(evidence ResponseEvidence) ClassifiedResponse
}

// HasCapability reports whether the provider-level capability record enables
// a given surface. Providers that need to consult per-model overrides should
// implement that logic on the model itself, not via this helper.
func HasCapability(caps ProviderCaps, surface Surface) bool {
	for _, s := range caps.Surfaces {
		if s == surface {
			return true
		}
	}
	return false
}

// EffectiveCompatibility returns a defensive typed policy for provider-level
// callers that do not have a model override.
func (caps ProviderCaps) EffectiveCompatibility() CompatibilityPolicy {
	return EffectiveCompatibilityPolicy(caps, nil)
}

// EffectiveCompatibility returns the model policy over the provider fallback.
func (m ProviderModel) EffectiveCompatibility(provider ProviderCaps) CompatibilityPolicy {
	return EffectiveCompatibilityPolicy(provider, &m)
}
