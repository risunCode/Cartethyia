package builtin

func BlackboxAI() ProviderDefinition {
	return ProviderDefinition{
		ID: "blackboxai", DisplayName: "Blackbox AI", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.blackbox.ai/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("z-ai/glm-5.2", "z-ai/glm-5.2", nil)},
	}
}
