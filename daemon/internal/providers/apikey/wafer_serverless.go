package apikey

func WaferServerless() ProviderDefinition {
	return ProviderDefinition{
		ID: "wafer-serverless", DisplayName: "Wafer Serverless", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://api.wafer.ai/v1", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("GLM-5.1", "GLM-5.1", nil)},
	}
}
