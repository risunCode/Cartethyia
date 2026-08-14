package apikey

func Meta() ProviderDefinition {
	return ProviderDefinition{
		ID: "meta", DisplayName: "Meta Model API", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.llama.com/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		ModelsDevID: "meta",
		Models: []ProviderModel{
			{ID: "muse-spark-1.2", DisplayName: "Muse Spark 1.2", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "muse-spark-1.1", DisplayName: "Muse Spark 1.1", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
			{ID: "muse-spark-1.2-contributor", DisplayName: "Muse Spark 1.2 Contributor", Capabilities: &ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true}},
		},
	}
}
