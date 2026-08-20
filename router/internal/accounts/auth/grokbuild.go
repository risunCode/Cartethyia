package auth

// NewGrokBuild constructs the Grok Build OAuth driver with its provider
// defaults, while allowing callers to override transport and lifecycle config.
func NewGrokBuild(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderGrokBuild), cfg))
}

// NewGrokBuildDefault constructs the Grok Build driver with default settings.
func NewGrokBuildDefault() (*HTTPDriver, error) { return NewGrokBuild(Config{}) }

func GrokBuild() ProviderDefinition {
	return ProviderDefinition{
		ID: "grok-build", DisplayName: "Grok Build", Protocol: ProtocolOpenAI, Adapter: AdapterGrok, CredentialKind: CredentialOAuth, BaseURL: "https://cli-chat-proxy.grok.com/v1", Surfaces: []Surface{SurfaceOpenAIResponses},
		Models: []ProviderModel{
			Model("grok-4.20-0309-reasoning", "Grok 4.20 Reasoning", nil),
			Model("grok-4.20-0309-non-reasoning", "Grok 4.20", nil),
			Model("grok-4.20-multi-agent-0309", "Grok 4.20 Multi-Agent", nil),
			Model("grok-4.5", "Grok 4.5", nil),
		},
	}
}
