package builtin

func NanoGPT() ProviderDefinition {
	return ProviderDefinition{
		ID: "nanogpt", DisplayName: "NanoGPT", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://nano-gpt.com/api/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("openai/gpt-5.5", "openai/gpt-5.5", nil)},
	}
}
