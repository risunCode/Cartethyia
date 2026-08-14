package oauth

import "github.com/cartethyia/daemon/internal/providers"

type ProviderDefinition = providers.ProviderDefinition
type ProviderModel = providers.ProviderModel
type CatalogOverrides = providers.CatalogOverrides

type Surface = providers.Surface

const (
	ProtocolOpenAI         = providers.ProtocolOpenAI
	ProtocolAnthropic      = providers.ProtocolAnthropic
	AdapterOpenAI          = providers.AdapterOpenAI
	AdapterAnthropic       = providers.AdapterAnthropic
	AdapterGrok            = providers.AdapterGrok
	AdapterCodex           = providers.AdapterCodex
	AdapterAntigravity     = providers.AdapterAntigravity
	CredentialOAuth        = providers.CredentialOAuth
	SurfaceOpenAIChat      = providers.SurfaceOpenAIChat
	SurfaceOpenAIResponses = providers.SurfaceOpenAIResponses
)

var Model = providers.Model
var ModelWithUpstream = providers.ModelWithUpstream
