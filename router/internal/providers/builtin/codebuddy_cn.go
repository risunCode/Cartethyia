package builtin

func CodeBuddyCN() ProviderDefinition {
	return ProviderDefinition{
		ID: "codebuddy-cn", DisplayName: "CodeBuddy China", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://www.codebuddy.cn/v2", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("glm-5.2", "glm-5.2", nil)},
	}
}
