package apikey

func Novita() ProviderDefinition {
	return ProviderDefinition{
		ID: "novita", DisplayName: "Novita", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.novita.ai/openai", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("moonshotai/kimi-k2.7-code", "moonshotai/kimi-k2.7-code", nil)},
	}
}
