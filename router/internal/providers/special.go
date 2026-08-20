package providers

// SpecialDefinitions returns providers whose wire protocols or credentials are
// not safely represented by the OpenAI/Anthropic catalog adapters yet. They are
// root-owned definitions so their protocol boundary remains visible.
func SpecialDefinitions() []ProviderDefinition {
	definitions := []ProviderDefinition{AgentRouter()}
	for index := range definitions {
		definitions[index] = CompleteDefinition(definitions[index])
	}
	return definitions
}
