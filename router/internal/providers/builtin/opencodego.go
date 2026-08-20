package builtin

func OpenCodeGo() ProviderDefinition {
	return ProviderDefinition{ID: "opencodego", DisplayName: "OpenCode Go", Protocol: ProtocolOpenAI, Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey, BaseURL: "https://opencode.ai/zen/go/v1", Surfaces: []Surface{SurfaceOpenAIChat}, ModelsDevID: "opencode-go", Models: []ProviderModel{
		{ID: "deepseek-v4-flash", DisplayName: "DeepSeek V4 Flash", ContextWindow: 1000000, MaxOutput: 384000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "deepseek-v4-pro", DisplayName: "DeepSeek V4 Pro", ContextWindow: 1000000, MaxOutput: 384000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "glm-5", DisplayName: "GLM-5", ContextWindow: 202752, MaxOutput: 32768, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "glm-5.1", DisplayName: "GLM-5.1", ContextWindow: 202752, MaxOutput: 32768, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "glm-5.2", DisplayName: "GLM-5.2", ContextWindow: 1000000, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "grok-4.5", DisplayName: "Grok 4.5", ContextWindow: 500000, MaxOutput: 500000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "hy3", DisplayName: "Hy3", ContextWindow: 256000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "kimi-k2.5", DisplayName: "Kimi K2.5", ContextWindow: 262144, MaxOutput: 65536, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "kimi-k2.6", DisplayName: "Kimi K2.6", ContextWindow: 262144, MaxOutput: 65536, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "kimi-k2.7-code", DisplayName: "Kimi K2.7 Code", ContextWindow: 262144, MaxOutput: 262144, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "kimi-k3", DisplayName: "Kimi K3 (2x usage)", ContextWindow: 1048576, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "mimo-v2-omni", DisplayName: "MiMo-V2-Omni", ContextWindow: 262144, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "mimo-v2-pro", DisplayName: "MiMo-V2-Pro", ContextWindow: 1048576, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "mimo-v2.5", DisplayName: "MiMo V2.5", ContextWindow: 1000000, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "mimo-v2.5-pro", DisplayName: "MiMo V2.5 Pro", ContextWindow: 1048576, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "minimax-m2.5", DisplayName: "MiniMax-M2.5", ContextWindow: 204800, MaxOutput: 65536, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "minimax-m2.7", DisplayName: "MiniMax-M2.7", ContextWindow: 204800, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "minimax-m3", DisplayName: "MiniMax-M3", ContextWindow: 1000000, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "qwen3.5-plus", DisplayName: "Qwen3.5 Plus", ContextWindow: 262144, MaxOutput: 65536, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "qwen3.6-plus", DisplayName: "Qwen3.6 Plus", ContextWindow: 1000000, MaxOutput: 65536, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "qwen3.7-max", DisplayName: "Qwen3.7 Max", ContextWindow: 1000000, MaxOutput: 65536, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "qwen3.7-plus", DisplayName: "Qwen3.7 Plus", ContextWindow: 1000000, MaxOutput: 65536, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
	}}
}
