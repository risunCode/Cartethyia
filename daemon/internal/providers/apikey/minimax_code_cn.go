package apikey

func MiniMaxCodeCN() ProviderDefinition {
	return ProviderDefinition{
		ID: "minimax-code-cn", DisplayName: "MiniMax Coding Plan China", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.minimaxi.com/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("MiniMax-M3", "MiniMax-M3", nil)},
	}
}
