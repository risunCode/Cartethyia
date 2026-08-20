package auth

// NewCodex constructs the Codex device-code driver with its provider defaults,
// while allowing callers to override transport and lifecycle config.
func NewCodex(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderCodex), cfg))
}

// NewCodexDefault constructs the Codex driver with default settings.
func NewCodexDefault() (*HTTPDriver, error) { return NewCodex(Config{}) }

func Codex() ProviderDefinition {
	return ProviderDefinition{
		ID: "codex", DisplayName: "Codex ChatGPT", Protocol: ProtocolOpenAI,
		Adapter: AdapterCodex, CredentialKind: CredentialOAuth, BaseURL: "https://chatgpt.com/backend-api",
		Surfaces: []Surface{SurfaceOpenAIResponses},
		Models: []ProviderModel{
			Model("gpt-5.6-sol", "gpt-5.6-sol", nil),
			Model("gpt-5.6-terra", "gpt-5.6-terra", nil),
			Model("gpt-5.6-luna", "gpt-5.6-luna", nil),
			Model("gpt-5.5", "gpt-5.5", nil),
			Model("gpt-5.4", "gpt-5.4", nil),
			Model("gpt-5.3-codex-spark", "gpt-5.3-codex-spark", nil)},
	}
}
