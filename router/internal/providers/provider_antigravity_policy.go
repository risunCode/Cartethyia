package providers

// Antigravity is the Google Cloud Code Assist request identity policy. The
// adapter owns the structured envelope; this policy records the stable
// fingerprint values so catalog code cannot accidentally inherit them.
var Antigravity = ProviderPolicy{
	ID:             "antigravity",
	UserAgent:      "antigravity/hub/2.1.4 windows/amd64",
	SystemPrompt:   "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task.**Absolute paths only****Proactiveness**",
	SessionScoped:  true,
	PromptCacheKey: true,
}
