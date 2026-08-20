package builtin

func ZAI() ProviderDefinition {
	return ProviderDefinition{
		ID: "zai", DisplayName: "zAI", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.z.ai/api/paas/v4", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "zai",
		Models: []ProviderModel{
			{ID: "glm-4.6", DisplayName: "GLM-4.6", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-4.5-flash", DisplayName: "GLM-4.5-Flash", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-5v-turbo", DisplayName: "GLM-5V-Turbo", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "glm-4.7", DisplayName: "GLM-4.7", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-4.5v", DisplayName: "GLM-4.5V", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "glm-4.7-flashx", DisplayName: "GLM-4.7-FlashX", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-5", DisplayName: "GLM-5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-5-turbo", DisplayName: "GLM-5-Turbo", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-5.2", DisplayName: "GLM-5.2", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-4.6v", DisplayName: "GLM-4.6V", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "glm-4.5-air", DisplayName: "GLM-4.5-Air", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-5.1", DisplayName: "GLM-5.1", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-4.7-flash", DisplayName: "GLM-4.7-Flash", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "glm-4.5", DisplayName: "GLM-4.5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
		},
	}
}
