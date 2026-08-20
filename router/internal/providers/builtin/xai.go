package builtin

func XAI() ProviderDefinition {
	return ProviderDefinition{
		ID: "xai", DisplayName: "xAI", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.x.ai/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "xai",
		Models: []ProviderModel{
			{ID: "grok-imagine-video", DisplayName: "Grok Imagine Video", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "grok-4.6", DisplayName: "Grok 4.6", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "grok-4.5", DisplayName: "Grok 4.5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "grok-4.20-0309-non-reasoning", DisplayName: "Grok 4.20 (Non-Reasoning)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: true}},
			{ID: "grok-imagine-video-1.5", DisplayName: "Grok Imagine Video 1.5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "grok-imagine-image-quality", DisplayName: "Grok Imagine Image Quality", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "grok-4.20-0309-reasoning", DisplayName: "Grok 4.20 (Reasoning)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "grok-4.20-multi-agent-0309", DisplayName: "Grok 4.20 Multi-Agent", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "grok-imagine-image", DisplayName: "Grok Imagine Image", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "grok-build-0.1", DisplayName: "Grok Build 0.1", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "grok-4.3", DisplayName: "Grok 4.3", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
		},
	}
}
