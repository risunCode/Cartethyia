package apikey

func MiniMax() ProviderDefinition {
	return ProviderDefinition{
		ID: "minimax", DisplayName: "MiniMax", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.minimax.io/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "minimax",
		Models: []ProviderModel{
			{ID: "MiniMax-M2.7", DisplayName: "MiniMax-M2.7", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "MiniMax-M2.7-highspeed", DisplayName: "MiniMax-M2.7-highspeed", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "MiniMax-M2.1", DisplayName: "MiniMax-M2.1", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "MiniMax-M2", DisplayName: "MiniMax-M2", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "MiniMax-M2.5-highspeed", DisplayName: "MiniMax-M2.5-highspeed", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "MiniMax-M3", DisplayName: "MiniMax-M3", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "MiniMax-M2.5", DisplayName: "MiniMax-M2.5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
		},
	}
}
