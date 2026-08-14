package apikey

func FirePass() ProviderDefinition {
	return ProviderDefinition{
		ID: "firepass", DisplayName: "FirePass", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.fireworks.ai/inference/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("kimi-k2.6-turbo", "kimi-k2.6-turbo", nil)},
	}
}
