package builtin

func Cerebras() ProviderDefinition {
	return ProviderDefinition{
		ID: "cerebras", DisplayName: "Cerebras", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.cerebras.ai/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "cerebras",
		Models: []ProviderModel{
			{ID: "zai-glm-4.7", DisplayName: "Z.AI GLM-4.7", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "gpt-oss-120b", DisplayName: "GPT OSS 120B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "gemma-4-31b", DisplayName: "Gemma 4 31B IT", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
		},
	}
}
