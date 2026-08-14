package oauth

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
