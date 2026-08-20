package builtin

import "github.com/cartethyia/daemon/internal/providers"

type ProviderDefinition = providers.ProviderDefinition
type ProviderModel = providers.ProviderModel
type ProviderCaps = providers.ProviderCaps
type Surface = providers.Surface
type HandwrittenModel = providers.HandwrittenModel
type CatalogOverrides = providers.CatalogOverrides

type CredentialKind = providers.CredentialKind

const (
	ProtocolOpenAI           = providers.ProtocolOpenAI
	ProtocolAnthropic        = providers.ProtocolAnthropic
	AdapterOpenAI            = providers.AdapterOpenAI
	AdapterAnthropic         = providers.AdapterAnthropic
	AdapterAgentRouter       = providers.AdapterAgentRouter
	CredentialAPIKey         = providers.CredentialAPIKey
	CredentialNone           = providers.CredentialNone
	SurfaceOpenAIChat        = providers.SurfaceOpenAIChat
	SurfaceOpenAIResponses   = providers.SurfaceOpenAIResponses
	SurfaceImages            = providers.SurfaceImages
	SurfaceAnthropicMessages = providers.SurfaceAnthropicMessages
)

var Model = providers.Model
var ModelWithUpstream = providers.ModelWithUpstream
var HandwrittenModels = providers.HandwrittenModels

func openAIProvider(id, displayName, baseURL, modelsDevID string, models ...[]ProviderModel) providers.ProviderDefinition {
	var fallback []ProviderModel
	if len(models) > 0 {
		fallback = models[0]
	}
	return providers.ProviderDefinition{
		ID: id, DisplayName: displayName, Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: baseURL, Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: modelsDevID, Models: fallback,
	}
}
