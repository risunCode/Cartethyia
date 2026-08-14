package apikey

func VercelAIGateway() ProviderDefinition {
	return ProviderDefinition{
		ID: "vercel-ai-gateway", DisplayName: "Vercel AI Gateway", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://ai-gateway.vercel.sh/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("anthropic/claude-opus-4.8", "anthropic/claude-opus-4.8", nil)},
	}
}
