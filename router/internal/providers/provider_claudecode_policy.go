package providers

// ClaudeCode is the request identity policy for Claude Code OAuth traffic.
var ClaudeCode = ProviderPolicy{
	ID:             "claude",
	UserAgent:      "claude-cli/2.1.165 (external, local-agent, agent-sdk/0.3.165)",
	SystemPrompt:   "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
	SessionScoped:  true,
	PromptCacheKey: true,
}
