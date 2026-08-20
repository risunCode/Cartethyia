package builtin

func AlibabaTokenPlan() ProviderDefinition {
	return ProviderDefinition{
		ID: "alibaba-token-plan", DisplayName: "Alibaba Token Plan", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "alibaba-token-plan",
		Models: []ProviderModel{
			{ID: "kimi-k2.7-code", DisplayName: "Kimi K2.7 Code", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "qwen3.8-max-preview", DisplayName: "Qwen3.8 Max Preview", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "qwen3.7-max", DisplayName: "Qwen3.7 Max", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "deepseek-v4-flash", DisplayName: "DeepSeek V4 Flash", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "wan2.7-image", DisplayName: "Wan2.7 Image", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "deepseek-v4-pro", DisplayName: "DeepSeek V4 Pro", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "deepseek-v3.2", DisplayName: "DeepSeek V3.2", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-5", DisplayName: "GLM-5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "happyhorse-1.1-i2v", DisplayName: "HappyHorse 1.1 Image-to-Video", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "qwen3.8-max", DisplayName: "Qwen3.8 Max", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "qwen3.7-plus", DisplayName: "Qwen3.7 Plus", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "happyhorse-1.1-r2v", DisplayName: "HappyHorse 1.1 Reference-to-Video", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "kimi-k2.5", DisplayName: "Kimi K2.5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "glm-5.2", DisplayName: "GLM-5.2", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "qwen-image-2.0", DisplayName: "Qwen Image 2.0", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "qwen3.6-plus", DisplayName: "Qwen3.6 Plus", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "glm-5.1", DisplayName: "GLM-5.1", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "qwen-image-2.0-pro", DisplayName: "Qwen Image 2.0 Pro", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "wan2.7-image-pro", DisplayName: "Wan2.7 Image Pro", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "MiniMax-M2.5", DisplayName: "MiniMax-M2.5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "deepseek-v4-flash-0731", DisplayName: "DeepSeek V4 Flash 0731", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "happyhorse-1.1-t2v", DisplayName: "HappyHorse 1.1 Text-to-Video", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "qwen3.6-flash", DisplayName: "Qwen3.6 Flash", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "kimi-k2.6", DisplayName: "Kimi K2.6", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
		},
	}
}
