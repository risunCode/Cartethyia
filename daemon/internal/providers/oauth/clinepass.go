package oauth

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
