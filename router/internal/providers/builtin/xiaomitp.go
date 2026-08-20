package builtin

func XiaomiPAYG() ProviderDefinition {
	return ProviderDefinition{ID: "xiaomipg", DisplayName: "Xiaomi MiMo PAYG", Protocol: ProtocolOpenAI, Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey, BaseURL: "https://api.xiaomimimo.com/v1", Surfaces: []Surface{SurfaceOpenAIChat}, ModelsDevID: "xiaomi", Models: []ProviderModel{
		{ID: "mimo-v2-flash", DisplayName: "MiMo-V2-Flash", ContextWindow: 262144, MaxOutput: 65536, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "mimo-v2-omni", DisplayName: "MiMo-V2-Omni", ContextWindow: 262144, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "mimo-v2-pro", DisplayName: "MiMo-V2-Pro", ContextWindow: 1048576, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "mimo-v2.5", DisplayName: "MiMo-V2.5", ContextWindow: 1048576, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "mimo-v2.5-pro", DisplayName: "MiMo-V2.5-Pro", ContextWindow: 1048576, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "mimo-v2.5-pro-ultraspeed", DisplayName: "MiMo-V2.5-Pro-UltraSpeed", ContextWindow: 1048576, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
	}}
}

func XiaomiTP() ProviderDefinition {
	return ProviderDefinition{ID: "xiaomitp", DisplayName: "Xiaomi MiMo Token Plan (Singapore)", Protocol: ProtocolOpenAI, Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey, BaseURL: "https://token-plan-sgp.xiaomimimo.com/v1", Surfaces: []Surface{SurfaceOpenAIChat}, ModelsDevID: "xiaomi-token-plan-sgp", Models: []ProviderModel{
		{ID: "mimo-v2-omni", DisplayName: "MiMo-V2-Omni", ContextWindow: 262144, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "mimo-v2-pro", DisplayName: "MiMo-V2-Pro", ContextWindow: 1048576, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
		{ID: "mimo-v2.5", DisplayName: "MiMo-V2.5", ContextWindow: 1048576, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		{ID: "mimo-v2.5-pro", DisplayName: "MiMo-V2.5-Pro", ContextWindow: 1048576, MaxOutput: 131072, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: false, Images: false}},
	}}
}
