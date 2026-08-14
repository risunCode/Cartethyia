package oauth

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
