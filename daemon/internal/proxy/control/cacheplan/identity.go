package cacheplan

import (
	"strings"

	"github.com/cartethyia/daemon/internal/providers"
)

// ApplyPromptCacheIdentity applies the sole deterministic provider-cache
// identity rule. It never includes tenant secrets or prompt digests in logs;
// callers may use the returned stable prefix only for provider wire fields.
func ApplyPromptCacheIdentity(payload map[string]any, surface, providerID, model string, enabled bool) (string, bool) {
	if payload == nil || !enabled {
		return "", false
	}
	protocol := ProtocolOpenAI
	if strings.Contains(strings.ToLower(surface), "anthropic") {
		protocol = ProtocolAnthropic
	}
	policy := providers.CompatibilityPolicy{Generation: 1, Cache: providers.CachePolicy{Prompt: providers.PromptCachePolicy{Supported: true, Key: true}}}
	intent, err := PlanFinalWire(&FinalWireRequest{Protocol: protocol, Surface: surface, ProviderID: providerID, ModelID: model, Payload: payload}, policy)
	if err != nil || !intent.Eligible {
		return "", false
	}
	return intent.StablePrefix, true
}
