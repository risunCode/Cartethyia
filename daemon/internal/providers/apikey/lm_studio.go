package apikey

func LMStudio() ProviderDefinition {
	return ProviderDefinition{
		ID: "lm-studio", DisplayName: "LM Studio", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "http://localhost:1234/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("llama-3-8b", "llama-3-8b", nil)},
	}
}
