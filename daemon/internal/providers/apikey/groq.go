package apikey

func Groq() ProviderDefinition {
	return ProviderDefinition{
		ID: "groq", DisplayName: "Groq", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.groq.com/openai/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "groq",
		Models: []ProviderModel{
			{ID: "whisper-large-v3", DisplayName: "Whisper", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "llama-3.3-70b-versatile", DisplayName: "Llama 3.3 70B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "allam-2-7b", DisplayName: "ALLaM-2-7b", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "llama-3.1-8b-instant", DisplayName: "Llama 3.1 8B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: true, Images: false}},
			{ID: "whisper-large-v3-turbo", DisplayName: "Whisper Large V3 Turbo", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "openai/gpt-oss-120b", DisplayName: "GPT OSS 120B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "openai/gpt-oss-safeguard-20b", DisplayName: "Safety GPT OSS 20B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "openai/gpt-oss-20b", DisplayName: "GPT OSS 20B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "qwen/qwen3.6-27b", DisplayName: "Qwen3.6 27B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "meta-llama/llama-prompt-guard-2-86m", DisplayName: "Prompt Guard 2 86M", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "meta-llama/llama-prompt-guard-2-22m", DisplayName: "Llama Prompt Guard 2 22M", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "groq/compound-mini", DisplayName: "Compound Mini", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "groq/compound", DisplayName: "Compound", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "canopylabs/orpheus-arabic-saudi", DisplayName: "Canopy Labs Orpheus Arabic Saudi", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
			{ID: "canopylabs/orpheus-v1-english", DisplayName: "Canopy Labs Orpheus V1 English", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: false, ToolCalls: false, Images: false}},
		},
	}
}
