package builtin

func Qianfan() ProviderDefinition {
	return ProviderDefinition{
		ID: "qianfan", DisplayName: "Qianfan", Protocol: ProtocolOpenAI,
		Adapter: AdapterOpenAI, CredentialKind: CredentialAPIKey,
		BaseURL: "https://qianfan.baidubce.com/v2", Surfaces: []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{Model("deepseek-v3.2", "deepseek-v3.2", nil)},
	}
}
