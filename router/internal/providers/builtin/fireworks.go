package builtin

func Fireworks() ProviderDefinition {
	return ProviderDefinition{
		ID: "fireworks", DisplayName: "Fireworks AI", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.fireworks.ai/inference/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("kimi-k2.7-code", "kimi-k2.7-code", nil)},
	}
}
