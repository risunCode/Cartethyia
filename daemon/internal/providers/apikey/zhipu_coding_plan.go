package apikey

func ZhipuCodingPlan() ProviderDefinition {
	return ProviderDefinition{
		ID: "zhipu-coding-plan", DisplayName: "Zhipu Coding Plan", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://open.bigmodel.cn/api/coding/paas/v4", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("glm-5.1", "glm-5.1", nil)},
	}
}
