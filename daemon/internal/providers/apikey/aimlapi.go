package apikey

func AIMLAPI() ProviderDefinition {
	return ProviderDefinition{
		ID: "aimlapi", DisplayName: "AIML API", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.aimlapi.com/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("gpt-5.5-2026-04-23", "gpt-5.5-2026-04-23", nil)},
	}
}
