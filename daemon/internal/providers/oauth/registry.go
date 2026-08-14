package oauth

import "github.com/cartethyia/daemon/internal/providers"

func Definitions() []providers.ProviderDefinition {
	return []providers.ProviderDefinition{Antigravity(), ClaudeCode(), Cline(), ClinePass(), Codex(), GrokBuild(), Kimchi(), Kiro()}
}
