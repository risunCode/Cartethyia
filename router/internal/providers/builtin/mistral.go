package builtin

func Mistral() ProviderDefinition {
	return ProviderDefinition{
		ID: "mistral", DisplayName: "Mistral", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.mistral.ai/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "mistral",
		Models: []ProviderModel{
			{ID: "mistral-medium-2508", DisplayName: "Mistral Medium 3.1", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: true}},
			{ID: "mistral-small-latest", DisplayName: "Mistral Small (latest)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "open-mixtral-8x7b", DisplayName: "Mixtral 8x7B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "mistral-large-2411", DisplayName: "Mistral Large 2.1", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "mistral-nemo", DisplayName: "Mistral Nemo", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "mistral-large-latest", DisplayName: "Mistral Large (latest)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: true}},
			{ID: "mistral-small-2603", DisplayName: "Mistral Small 4", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "magistral-small", DisplayName: "Magistral Small", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "voxtral-mini-latest", DisplayName: "Voxtral Mini (latest)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "mistral-small-2506", DisplayName: "Mistral Small 3.2", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: true}},
			{ID: "pixtral-large-latest", DisplayName: "Pixtral Large (latest)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: true}},
			{ID: "mistral-large-2512", DisplayName: "Mistral Large 3", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: true}},
			{ID: "ministral-3b-latest", DisplayName: "Ministral 3B (latest)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "mistral-medium-2604", DisplayName: "Mistral Medium 3.5", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "ministral-8b-latest", DisplayName: "Ministral 8B (latest)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "mistral-medium-2505", DisplayName: "Mistral Medium 3", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: true}},
			{ID: "open-mistral-7b", DisplayName: "Mistral 7B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "voxtral-mini-tts-latest", DisplayName: "Voxtral Mini TTS (latest)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "pixtral-12b", DisplayName: "Pixtral 12B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: true}},
			{ID: "voxtral-small-latest", DisplayName: "Voxtral Small (latest)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: true}},
			{ID: "codestral-latest", DisplayName: "Codestral (latest)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "open-mixtral-8x22b", DisplayName: "Mixtral 8x22B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "magistral-medium-latest", DisplayName: "Magistral Medium (latest)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "mistral-embed", DisplayName: "Mistral Embed", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "mistral-medium-latest", DisplayName: "Mistral Medium (latest)", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
		},
	}
}
