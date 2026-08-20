package builtin

func QwenPortal() ProviderDefinition {
	return ProviderDefinition{
		ID: "qwen-portal", DisplayName: "Qwen Portal", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://portal.qwen.ai/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("coder-model", "coder-model", nil)},
	}
}
