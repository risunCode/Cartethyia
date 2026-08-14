package apikey

func Ollama() ProviderDefinition {
	return ProviderDefinition{
		ID: "ollama", DisplayName: "Ollama", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "http://localhost:11434/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("gpt-oss:20b", "gpt-oss:20b", nil)},
	}
}
