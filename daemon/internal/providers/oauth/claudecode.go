package oauth

func ClaudeCode() ProviderDefinition {
	return ProviderDefinition{
		ID: "claude", DisplayName: "Claude Code", Protocol: ProtocolAnthropic,
		Adapter: AdapterAnthropic, CredentialKind: CredentialOAuth,
		BaseURL: "https://api.anthropic.com/v1", AuthMode: "bearer", ModelsDevID: "anthropic",
		Models: []ProviderModel{
			Model("claude-opus-5", "Claude Opus 5", nil),
			Model("claude-sonnet-5", "Claude Sonnet 5", nil),
			Model("claude-fable-5", "Claude Fable 5", nil),
			Model("claude-haiku-4-5", "Claude Haiku 4.5", nil),
		},
	}
}
