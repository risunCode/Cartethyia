package builtin

func Baseten() ProviderDefinition {
	return ProviderDefinition{
		ID: "baseten", DisplayName: "Baseten", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://inference.baseten.co/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "baseten",
		Models: []ProviderModel{
			{ID: "nvidia/Nemotron-120B-A12B", DisplayName: "Nemotron Super", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B", DisplayName: "Nemotron Ultra", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "moonshotai/Kimi-K2.5", DisplayName: "Kimi K2.5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "moonshotai/Kimi-K2.7-Code", DisplayName: "Kimi K2.7 Code", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "moonshotai/Kimi-K3", DisplayName: "Kimi K3", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "moonshotai/Kimi-K2.6", DisplayName: "Kimi K2.6", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "openai/gpt-oss-120b", DisplayName: "OpenAI GPT 120B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "deepseek-ai/DeepSeek-V4-Pro", DisplayName: "Deepseek V4 Pro", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "deepseek-ai/DeepSeek-V4-Flash-0731", DisplayName: "Deepseek V4 Flash 0731", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "zai-org/GLM-5.1", DisplayName: "GLM 5.1", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "zai-org/GLM-5.2-Fast", DisplayName: "GLM 5.2 Fast", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "zai-org/GLM-5", DisplayName: "GLM 5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "zai-org/GLM-4.7", DisplayName: "GLM 4.7", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "zai-org/GLM-5.2", DisplayName: "GLM 5.2", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "thinkingmachines/inkling-small", DisplayName: "Inkling Small", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "thinkingmachines/inkling", DisplayName: "Inkling", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
		},
	}
}
