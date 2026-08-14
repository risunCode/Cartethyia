package apikey

func OpenCodeFree() ProviderDefinition {
	return ProviderDefinition{ID: "zenfree", DisplayName: "OpenCode Free", Protocol: ProtocolOpenAI, Adapter: AdapterOpenAI, CredentialKind: CredentialNone, BaseURL: "https://opencode.ai/zen/v1", Surfaces: []Surface{SurfaceOpenAIChat}, ModelsDevID: "opencode-zen", Models: []ProviderModel{
		{ID: "big-pickle", DisplayName: "Big Pickle", ContextWindow: 200000, MaxOutput: 32000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "deepseek-v4-flash-free", DisplayName: "DeepSeek V4 Flash Free", ContextWindow: 200000, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "hy3-free", DisplayName: "Hy3 Free", ContextWindow: 190000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "hy3-preview-free", DisplayName: "Hy3 preview Free", ContextWindow: 256000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "laguna-s-2.1-free", DisplayName: "Laguna S 2.1 Free", ContextWindow: 256000, MaxOutput: 32000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "ling-3.0-flash-free", DisplayName: "Ling-3.0-flash Free", ContextWindow: 262144, MaxOutput: 32768, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "mimo-v2-flash-free", DisplayName: "MiMo V2 Flash Free", ContextWindow: 262144, MaxOutput: 65536, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "mimo-v2-omni-free", DisplayName: "MiMo V2 Omni Free", ContextWindow: 262144, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "mimo-v2-pro-free", DisplayName: "MiMo V2 Pro Free", ContextWindow: 1048576, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "mimo-v2.5-free", DisplayName: "MiMo V2.5 Free", ContextWindow: 200000, MaxOutput: 32000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "minimax-m2.5-free", DisplayName: "MiniMax M2.5 Free", ContextWindow: 204800, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "minimax-m3-free", DisplayName: "MiniMax M3 Free", ContextWindow: 200000, MaxOutput: 32000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "nemotron-3-super-free", DisplayName: "Nemotron 3 Super Free", ContextWindow: 204800, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "nemotron-3-ultra-free", DisplayName: "Nemotron 3 Ultra Free", ContextWindow: 1000000, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "north-mini-code-free", DisplayName: "North Mini Code Free", ContextWindow: 256000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "qwen3.6-plus-free", DisplayName: "Qwen3.6 Plus Free", ContextWindow: 1048576, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "ring-2.6-1t-free", DisplayName: "Ring 2.6 1T Free", ContextWindow: 262000, MaxOutput: 66000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "trinity-large-preview-free", DisplayName: "Trinity Large Preview", ContextWindow: 131072, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
	}}
}
