package apikey

func Together() ProviderDefinition {
	return ProviderDefinition{
		ID: "together", DisplayName: "Together AI", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.together.xyz/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("moonshotai/Kimi-K2.7-Code", "moonshotai/Kimi-K2.7-Code", nil)},
	}
}
