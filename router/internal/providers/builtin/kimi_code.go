package builtin

func KimiCode() ProviderDefinition {
	return ProviderDefinition{
		ID: "kimi-code", DisplayName: "Kimi Code", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.kimi.com/coding/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("kimi-for-coding", "kimi-for-coding", nil)},
	}
}
