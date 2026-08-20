package providers

// GrokBuild is the Grok Build OAuth request identity policy.
var GrokBuild = ProviderPolicy{ID: "grok-build", UserAgent: "grok-build", SessionScoped: true, PromptCacheKey: true}
