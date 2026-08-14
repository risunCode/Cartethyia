package oauth

func Kiro() ProviderDefinition {
	return ProviderDefinition{
		ID: "kiro", DisplayName: "Kiro", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialOAuth, BaseURL: "https://runtime.us-east-1.kiro.dev",
		Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{
			Model("claude-opus-4.8", "claude-opus-4.8", nil),
			Model("claude-sonnet-5", "claude-sonnet-5", nil),
			Model("auto", "auto", nil),
			Model("deepseek-3.2", "deepseek-3.2", nil),
			Model("qwen3-coder-next", "qwen3-coder-next", nil),
			Model("glm-5", "glm-5", nil),
			Model("gpt-5.6-sol", "gpt-5.6-sol", nil)},
	}
}
