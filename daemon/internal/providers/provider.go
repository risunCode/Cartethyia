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

	domaincontracts "github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// Surface is the canonical client-facing protocol surface shared with the
// proxy contract package.
type Surface = domaincontracts.Surface

const (
	// SurfaceOpenAIChat is the legacy OpenAI Chat Completions wire format.
	SurfaceOpenAIChat = domaincontracts.SurfaceOpenAIChat
	// SurfaceOpenAIResponses is the OpenAI Responses API wire format.
	SurfaceOpenAIResponses = domaincontracts.SurfaceOpenAIResponses
	// SurfaceAnthropicMessages is the Anthropic Messages wire format.
	SurfaceAnthropicMessages = domaincontracts.SurfaceAnthropic
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
type ClassifiedResponse struct {
	// StatusCode is the upstream HTTP status, when available.
	StatusCode int
	// Retryable reports whether a routing layer should retry the request on
	// a different account. It is independent of the Provider's error
	// classification: a 401 is not retryable, a 429 with retry-after is.
	Retryable bool
	// Category groups the upstream response into a routing bucket. The
	// runtime uses the category to drive telemetry and health updates.
	Category ResponseCategory
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
	// ClassifyResponse maps a raw upstream response into a routing bucket.
	// The body is the upstream payload as read by the transport; providers
	// may inspect a bounded prefix to distinguish 4xx sub-categories.
	ClassifyResponse(statusCode int, body []byte) ClassifiedResponse
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
