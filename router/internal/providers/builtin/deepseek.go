package builtin

func DeepSeek() ProviderDefinition {
	return ProviderDefinition{
		ID: "deepseek", DisplayName: "DeepSeek", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.deepseek.com/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "deepseek",
		Models: []ProviderModel{
			{ID: "deepseek-v4-flash", DisplayName: "DeepSeek V4 Flash", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "deepseek-v4-pro", DisplayName: "DeepSeek V4 Pro", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "deepseek-chat", DisplayName: "DeepSeek Chat", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: true}},
			{ID: "deepseek-reasoner", DisplayName: "DeepSeek Reasoner", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
		},
	}
}
