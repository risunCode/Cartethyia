package builtin

func LiteLLM() ProviderDefinition {
	return ProviderDefinition{
		ID: "litellm", DisplayName: "LiteLLM", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "http://localhost:4000/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("claude-opus-4-8", "claude-opus-4-8", nil)},
	}
}
