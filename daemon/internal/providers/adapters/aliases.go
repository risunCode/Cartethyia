package adapters

import p "github.com/cartethyia/daemon/internal/providers"

type Provider = p.Provider
type ProviderMeta = p.ProviderMeta
type ProviderCaps = p.ProviderCaps
type ProviderModel = p.ProviderModel
type ProviderModelCatalog = p.ProviderModelCatalog
type ProviderModelMetadata = p.ModelMetadata
type ModelPricing = p.ModelPricing
type Surface = p.Surface
type Protocol = p.Protocol
type CredentialKind = p.CredentialKind
type IDMismatchError = p.IDMismatchError
type AuthError = p.AuthError
type RequestEnvelope = p.RequestEnvelope
type BuiltRequest = p.BuiltRequest
type AuthMaterial = p.AuthMaterial
type RouteTarget = p.RouteTarget
type Endpoint = p.Endpoint
type ClassifiedResponse = p.ClassifiedResponse
type ResponseCategory = p.ResponseCategory

type UnknownModelError = p.UnknownModelError
type UnknownSurfaceError = p.UnknownSurfaceError

const (
	SurfaceOpenAIChat        = p.SurfaceOpenAIChat
	SurfaceOpenAIResponses   = p.SurfaceOpenAIResponses
	SurfaceAnthropicMessages = p.SurfaceAnthropicMessages
	SurfaceImages            = p.SurfaceImages
	SurfaceWebSearch         = p.SurfaceWebSearch
	ProtocolOpenAI           = p.ProtocolOpenAI
	ProtocolAnthropic        = p.ProtocolAnthropic
	CredentialAPIKey         = p.CredentialAPIKey
	CredentialOAuth          = p.CredentialOAuth
	CredentialNone           = p.CredentialNone
	CategorySuccess          = p.CategorySuccess
	CategoryAuth             = p.CategoryAuth
	CategoryEntitlement      = p.CategoryEntitlement
	CategoryRateLimit        = p.CategoryRateLimit
	CategoryQuota            = p.CategoryQuota
	CategoryCapacity         = p.CategoryCapacity
	CategoryContentPolicy    = p.CategoryContentPolicy
	CategoryEmptyOutput      = p.CategoryEmptyOutput
	CategoryInvalidRequest   = p.CategoryInvalidRequest
	CategoryTransient        = p.CategoryTransient
	CategoryServerError      = p.CategoryServerError
	CategoryFatal            = p.CategoryFatal
)

var Model = p.Model
var ModelWithUpstream = p.ModelWithUpstream
var HasCapability = p.HasCapability
