package builtin

func VLLM() ProviderDefinition {
	return ProviderDefinition{
		ID: "vllm", DisplayName: "vLLM", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "http://localhost:8000/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("gpt-oss-20b", "gpt-oss-20b", nil)},
	}
}
