package builtin

func Umans() ProviderDefinition {
	return ProviderDefinition{
		ID: "umans", DisplayName: "Umans AI", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.umans.ai/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("umans-coder", "umans-coder", nil)},
	}
}
