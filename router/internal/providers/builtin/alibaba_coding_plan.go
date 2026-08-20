package builtin

func AlibabaCodingPlan() ProviderDefinition {
	return ProviderDefinition{
		ID: "alibaba-coding-plan", DisplayName: "Alibaba Coding Plan", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://coding-intl.dashscope.aliyuncs.com/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "alibaba-coding-plan",
		Models: []ProviderModel{
			{ID: "qwen3.7-max", DisplayName: "Qwen3.7 Max", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-4.7", DisplayName: "GLM-4.7", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "qwen3-coder-next", DisplayName: "Qwen3 Coder Next", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "qwen3.5-plus", DisplayName: "Qwen3.5 Plus", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "glm-5", DisplayName: "GLM-5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "qwen3.7-plus", DisplayName: "Qwen3.7 Plus", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "kimi-k2.5", DisplayName: "Kimi K2.5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "qwen3.6-plus", DisplayName: "Qwen3.6 Plus", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "qwen3-max-2026-01-23", DisplayName: "Qwen3 Max", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "MiniMax-M2.5", DisplayName: "MiniMax-M2.5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "qwen3-coder-plus", DisplayName: "Qwen3 Coder Plus", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "qwen3.6-flash", DisplayName: "Qwen3.6 Flash", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
		},
	}
}
