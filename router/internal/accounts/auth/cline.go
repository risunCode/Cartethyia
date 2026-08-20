package auth

// NewCline constructs the Cline device-code driver with its provider defaults,
// while allowing callers to override transport and lifecycle config.
func NewCline(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderCline), cfg))
}

// NewClineDefault constructs the Cline driver with default settings.
func NewClineDefault() (*HTTPDriver, error) { return NewCline(Config{}) }

func Cline() ProviderDefinition {
	return ProviderDefinition{
		ID: "cline", DisplayName: "Cline", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialOAuth, BaseURL: "https://api.cline.bot/api/v1",
		Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{
			Model("deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash", nil),
			Model("z-ai/glm-5.2", "z-ai/glm-5.2", nil),
			Model("openai/gpt-5.6-sol-pro", "openai/gpt-5.6-sol-pro", nil),
			Model("openai/gpt-5.6-luna-pro", "openai/gpt-5.6-luna-pro", nil),
			Model("minimax/minimax-m3", "minimax/minimax-m3", nil)},
	}
}
