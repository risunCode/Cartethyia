package auth

// Protocol identifies the upstream wire protocol declared by an auth-owned
// provider descriptor. It intentionally remains a string contract so the
// provider catalog can convert it without importing this package back.
type Protocol string

const (
	ProtocolOpenAI    Protocol = "openai"
	ProtocolAnthropic Protocol = "anthropic"
)

// AdapterKind identifies the provider adapter required by a descriptor.
type AdapterKind string

const (
	AdapterOpenAI      AdapterKind = "openai"
	AdapterAnthropic   AdapterKind = "anthropic"
	AdapterGrok        AdapterKind = "grok"
	AdapterCodex       AdapterKind = "codex"
	AdapterAntigravity AdapterKind = "antigravity"
)

// Surface is the client-facing surface a provider can serve.
type Surface string

const (
	SurfaceOpenAIChat      Surface = "openai-chat"
	SurfaceOpenAIResponses Surface = "openai-responses"
)

// ProviderCaps is the optional model capability subset carried by an auth
// descriptor. OAuth descriptors currently use nil capabilities; keeping the
// shape explicit makes future provider requirements additive.
type ProviderCaps struct {
	Surfaces   []Surface
	Streaming  bool
	Reasoning  bool
	ToolCalls  bool
	Images     bool
}

// ProviderModel is the minimal catalog entry owned by an auth descriptor.
type ProviderModel struct {
	ID           string
	DisplayName  string
	UpstreamID   string
	Capabilities *ProviderCaps
}

// CatalogOverrides describes model restrictions owned by an auth descriptor.
type CatalogOverrides struct {
	AllowedModelIDs []string
}

// ProviderDefinition is the provider identity and OAuth catalog contract.
// The providers package converts it into its runtime descriptor at the
// composition root; auth itself never imports the providers runtime package.
type ProviderDefinition struct {
	ID             string
	DisplayName    string
	Protocol       Protocol
	Adapter        AdapterKind
	CredentialKind CredentialKind
	CredentialRef  string
	CredentialURL  string
	AuthMode       string
	BaseURL        string
	Surfaces       []Surface
	ModelsDevID    string
	Models         []ProviderModel
	Overrides      CatalogOverrides
}

func Model(id, displayName string, caps *ProviderCaps) ProviderModel {
	return ProviderModel{ID: id, DisplayName: displayName, Capabilities: caps}
}

func ModelWithUpstream(id, upstreamID, displayName string, caps *ProviderCaps) ProviderModel {
	return ProviderModel{ID: id, UpstreamID: upstreamID, DisplayName: displayName, Capabilities: caps}
}
