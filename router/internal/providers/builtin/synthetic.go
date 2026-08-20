package builtin

func Synthetic() ProviderDefinition {
	return ProviderDefinition{
		ID: "synthetic", DisplayName: "Synthetic", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.synthetic.new/openai/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "synthetic",
		Models: []ProviderModel{
			{ID: "hf:openai/gpt-oss-120b", DisplayName: "GPT OSS 120B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "hf:moonshotai/Kimi-K2.7-Code", DisplayName: "Kimi K2.7 Code", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "hf:moonshotai/Kimi-K3", DisplayName: "Kimi K3", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4", DisplayName: "Nemotron 3 Super 120B A12B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "hf:Qwen/Qwen3.6-27B", DisplayName: "Qwen3.6 27B", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "hf:MiniMaxAI/MiniMax-M3", DisplayName: "MiniMax-M3", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "hf:zai-org/GLM-5.2", DisplayName: "GLM-5.2", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
			{ID: "hf:zai-org/GLM-4.7-Flash", DisplayName: "GLM-4.7-Flash", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: false}},
		},
	}
}
