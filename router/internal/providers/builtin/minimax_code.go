package builtin

func MiniMaxCode() ProviderDefinition {
	return ProviderDefinition{
		ID: "minimax-code", DisplayName: "MiniMax Coding Plan", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.minimax.io/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("MiniMax-M3", "MiniMax-M3", nil)},
	}
}
