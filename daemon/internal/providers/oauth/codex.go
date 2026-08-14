package oauth

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
