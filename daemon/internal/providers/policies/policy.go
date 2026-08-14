package policies

// ProviderPolicy owns provider-specific identity and prompt behavior. Catalog
// metadata never contains fingerprints or system prompts; adapters consult a
// policy only when the upstream contract requires it.
type ProviderPolicy struct {
	ID             string
	UserAgent      string
	SystemPrompt   string
	Headers        map[string]string
	SessionScoped  bool
	PromptCacheKey bool
}

// Policy returns a copy of the provider policy, if one exists.
func Policy(id string) (ProviderPolicy, bool) {
	var policy ProviderPolicy
	switch id {
	case "claude":
		policy = ClaudeCode
	case "antigravity":
		policy = Antigravity
	case "codex":
		policy = Codex
	case "grok-build":
		policy = GrokBuild
	default:
		return ProviderPolicy{}, false
	}
	policy.Headers = cloneHeaders(policy.Headers)
	return policy, true
}

func cloneHeaders(headers map[string]string) map[string]string {
	if len(headers) == 0 {
		return nil
	}
	result := make(map[string]string, len(headers))
	for key, value := range headers {
		result[key] = value
	}
	return result
}
