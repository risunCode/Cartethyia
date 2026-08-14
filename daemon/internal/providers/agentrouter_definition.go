package providers

func AgentRouter() ProviderDefinition {
	return ProviderDefinition{
		ID: "agentrouter", DisplayName: "AgentRouter", Protocol: ProtocolAnthropic,
		Adapter: AdapterAnthropic, CredentialKind: CredentialAPIKey,
		BaseURL: "https://agentrouter.org/api/v1", Models: []ProviderModel{
			Model("claude-opus-4-8", "Claude Opus 4.8", nil),
		},
	}
}
