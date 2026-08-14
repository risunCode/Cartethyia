package policies

// Codex is the ChatGPT Codex OAuth request identity policy.
var Codex = ProviderPolicy{ID: "codex", UserAgent: "codex", SessionScoped: true, PromptCacheKey: true}
