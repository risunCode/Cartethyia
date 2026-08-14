package apikey

func CodeBuddy() ProviderDefinition {
	return ProviderDefinition{
		ID: "codebuddy", DisplayName: "CodeBuddy", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://www.codebuddy.ai/v2", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("gemini-3.5-flash", "gemini-3.5-flash", nil)},
	}
}
