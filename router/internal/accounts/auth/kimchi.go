package auth

// NewKimchi constructs the Kimchi access-only driver with its provider
// defaults, while allowing callers to override transport and lifecycle config.
func NewKimchi(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderKimchi), cfg))
}

// NewKimchiDefault constructs the Kimchi driver with default settings.
func NewKimchiDefault() (*HTTPDriver, error) { return NewKimchi(Config{}) }

func Kimchi() ProviderDefinition {
	return ProviderDefinition{
		ID: "kimchi", DisplayName: "Kimchi", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialOAuth, BaseURL: "https://llm.kimchi.dev/openai/v1",
		Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{
			Model("kimi-k2.7", "kimi-k2.7", nil),
			Model("minimax-m3", "minimax-m3", nil),
			Model("deepseek-v4-flash", "deepseek-v4-flash", nil),
			Model("nemotron-3-ultra-fp4", "nemotron-3-ultra-fp4", nil)},
	}
}
