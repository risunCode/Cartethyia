package auth

// NewClinePass constructs the ClinePass OAuth driver with its provider
// defaults, while allowing callers to override transport and lifecycle config.
func NewClinePass(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderClinePass), cfg))
}

// NewClinePassDefault constructs the ClinePass driver with default settings.
func NewClinePassDefault() (*HTTPDriver, error) { return NewClinePass(Config{}) }

func ClinePass() ProviderDefinition {
	return ProviderDefinition{
		ID: "clinepass", DisplayName: "ClinePass", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialOAuth, BaseURL: "https://api.cline.bot/api/v1",
		Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{
			Model("cline-pass/glm-5.2", "cline-pass/glm-5.2", nil),
			Model("cline-pass/kimi-k2.7-code", "cline-pass/kimi-k2.7-code", nil),
			Model("cline-pass/deepseek-v4-pro", "cline-pass/deepseek-v4-pro", nil),
			Model("cline-pass/minimax-m3", "cline-pass/minimax-m3", nil)},
	}
}
