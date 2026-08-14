package apikey

func CoreWeave() ProviderDefinition {
	return ProviderDefinition{
		ID: "coreweave", DisplayName: "CoreWeave", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.inference.wandb.ai/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("openai/gpt-oss-120b", "openai/gpt-oss-120b", nil)},
	}
}
