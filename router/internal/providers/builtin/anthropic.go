package builtin

func AnthropicAI() ProviderDefinition {
	return ProviderDefinition{
		ID: "anthropic", DisplayName: "Anthropic", Protocol: ProtocolAnthropic, Adapter: AdapterAnthropic, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.anthropic.com/v1", ModelsDevID: "anthropic",
		Models: []ProviderModel{
			{ID: "claude-3-5-sonnet-20240620", DisplayName: "Claude Sonnet 3.5", ContextWindow: 200000, MaxOutput: 8192, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "claude-3-5-sonnet-20241022", DisplayName: "Claude Sonnet 3.5 v2", ContextWindow: 200000, MaxOutput: 8192, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "claude-3-7-sonnet-20250219", DisplayName: "Claude Sonnet 3.7", ContextWindow: 200000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-3-haiku-20240307", DisplayName: "Claude Haiku 3", ContextWindow: 200000, MaxOutput: 4096, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "claude-3-opus-20240229", DisplayName: "Claude Opus 3", ContextWindow: 200000, MaxOutput: 4096, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "claude-3-sonnet-20240229", DisplayName: "Claude Sonnet 3", ContextWindow: 200000, MaxOutput: 4096, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "claude-fable-5", DisplayName: "Claude Fable 5", ContextWindow: 1000000, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-haiku-4-5", DisplayName: "Claude Haiku 4.5", ContextWindow: 200000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-haiku-4-5-20251001", DisplayName: "Claude Haiku 4.5", ContextWindow: 200000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-mythos-5", DisplayName: "Claude Mythos 5", ContextWindow: 1000000, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-opus-4-0", DisplayName: "Claude Opus 4", ContextWindow: 200000, MaxOutput: 32000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-opus-4-1", DisplayName: "Claude Opus 4.1", ContextWindow: 200000, MaxOutput: 32000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-opus-4-1-20250805", DisplayName: "Claude Opus 4.1", ContextWindow: 200000, MaxOutput: 32000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-opus-4-20250514", DisplayName: "Claude 4 Opus", ContextWindow: 200000, MaxOutput: 32000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "claude-opus-4-5", DisplayName: "Claude Opus 4.5", ContextWindow: 200000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-opus-4-5-20251101", DisplayName: "Claude Opus 4.5", ContextWindow: 200000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-opus-4-6", DisplayName: "Claude Opus 4.6", ContextWindow: 1000000, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-opus-4-7", DisplayName: "Claude Opus 4.7", ContextWindow: 1000000, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-opus-4-8", DisplayName: "Claude Opus 4.8", ContextWindow: 1000000, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-opus-5", DisplayName: "Claude Opus 5", ContextWindow: 1000000, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-sonnet-4-0", DisplayName: "Claude Sonnet 4", ContextWindow: 200000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-sonnet-4-20250514", DisplayName: "Claude 4 Sonnet", ContextWindow: 200000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: false, ToolCalls: false, Images: true}},
			{ID: "claude-sonnet-4-5", DisplayName: "Claude Sonnet 4.5", ContextWindow: 1000000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-sonnet-4-5-20250929", DisplayName: "Claude Sonnet 4.5", ContextWindow: 1000000, MaxOutput: 64000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-sonnet-4-6", DisplayName: "Claude Sonnet 4.6", ContextWindow: 1000000, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
			{ID: "claude-sonnet-5", DisplayName: "Claude Sonnet 5", ContextWindow: 1000000, MaxOutput: 128000, Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: true, Reasoning: true, ToolCalls: false, Images: true}},
		},
	}
}
