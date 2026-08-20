package auth

// NewAntigravity constructs the Antigravity OAuth driver with its provider
// defaults, while allowing callers to override transport and lifecycle config.
func NewAntigravity(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderAntigravity), cfg))
}

// NewAntigravityDefault constructs the Antigravity driver with default settings.
func NewAntigravityDefault() (*HTTPDriver, error) { return NewAntigravity(Config{}) }

func Antigravity() ProviderDefinition {
	return ProviderDefinition{
		ID: "antigravity", DisplayName: "Antigravity", Protocol: ProtocolOpenAI,
		Adapter: AdapterAntigravity, CredentialKind: CredentialOAuth,
		BaseURL: "https://daily-cloudcode-pa.googleapis.com", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{
			ModelWithUpstream("gemini-3.1-pro", "gemini-pro-agent", "Gemini 3.1 Pro", nil),
			ModelWithUpstream("gemini-3.5-flash", "gemini-3.5-flash-extra-low", "Gemini 3.5 Flash", nil),
			Model("gemini-3-flash", "Gemini 3 Flash", nil),
			Model("claude-sonnet-4-6", "Claude Sonnet 4.6", nil),
			ModelWithUpstream("gpt-oss-120b", "gpt-oss-120b-medium", "GPT OSS 120B", nil),
		},
		Overrides: CatalogOverrides{AllowedModelIDs: []string{"gemini-3.1-pro", "gemini-3.5-flash", "gemini-3-flash", "claude-sonnet-4-6", "gpt-oss-120b"}},
	}
}
