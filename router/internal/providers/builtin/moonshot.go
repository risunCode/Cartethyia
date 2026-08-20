package builtin

func Moonshot() ProviderDefinition {
	return ProviderDefinition{
		ID: "moonshot", DisplayName: "Moonshot", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.moonshot.ai/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("kimi-k2.7-code", "kimi-k2.7-code", nil)},
	}
}
