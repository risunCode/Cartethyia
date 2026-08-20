package builtin

import (
	"fmt"
	"strings"

	p "github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/providers/adapters"
)

func materialize(def p.ProviderDefinition) (p.Provider, error) {
	if strings.TrimSpace(def.ID) == "" {
		return nil, fmt.Errorf("provider definition has empty id")
	}
	models := resolveModels(def)
	def.Models = models
	def = p.CompleteDefinition(def)
	var provider p.Provider
	switch def.Adapter {
	case p.AdapterOpenAI:
		provider = adapters.NewOpenAIAdapter(adapters.OpenAIAdapterConfig{
			ID: def.ID, DisplayName: def.DisplayName, BaseURL: def.BaseURL,
			CredentialRef: def.CredentialRef, CredentialKind: def.CredentialKind,
			CredentialURL: def.CredentialURL, Surfaces: def.Surfaces, Models: models,
		})
	case p.AdapterAnthropic:
		provider = adapters.NewAnthropicAdapter(adapters.AnthropicAdapterConfig{
			ID: def.ID, DisplayName: def.DisplayName, BaseURL: def.BaseURL,
			CredentialRef: def.CredentialRef, CredentialKind: def.CredentialKind,
			Auth: def.AuthMode, Models: models,
		})
	case p.AdapterGrok:
		provider = adapters.NewGrokBuildAdapter(adapters.GrokBuildConfig{
			ID: def.ID, DisplayName: def.DisplayName, BaseURL: def.BaseURL,
			CredentialRef: def.CredentialRef, CredentialKind: def.CredentialKind,
			Models: models,
		})
	case p.AdapterCodex:
		provider = adapters.NewCodexAdapter(adapters.OpenAIAdapterConfig{
			ID: def.ID, DisplayName: def.DisplayName, BaseURL: def.BaseURL,
			CredentialRef: def.CredentialRef, CredentialKind: def.CredentialKind,
			CredentialURL: def.CredentialURL, Surfaces: def.Surfaces, Models: models,
		})
	case p.AdapterAntigravity:
		provider = adapters.NewAntigravityAdapter(adapters.OpenAIAdapterConfig{
			ID: def.ID, DisplayName: def.DisplayName, BaseURL: def.BaseURL,
			CredentialRef: def.CredentialRef, CredentialKind: def.CredentialKind,
			CredentialURL: def.CredentialURL, Surfaces: def.Surfaces, Models: models,
		})
	case p.AdapterAgentRouter:
		provider = adapters.NewAgentRouterAdapter(adapters.AgentRouterAdapterConfig{
			ID: def.ID, DisplayName: def.DisplayName, BaseURL: def.BaseURL,
			CredentialRef: def.CredentialRef, CredentialKind: def.CredentialKind,
			Models: models,
		})
	default:
		return nil, fmt.Errorf("provider %q has unsupported adapter %q", def.ID, def.Adapter)
	}
	return p.OverrideCapabilities(provider, def.Capabilities), nil
}

func resolveModels(def p.ProviderDefinition) []p.ProviderModel {
	if len(def.Models) > 0 {
		models := append([]p.ProviderModel(nil), def.Models...)
		for index := range models {
			if models[index].Metadata.Source == "" {
				models[index].Metadata.Source = "provider"
			}
		}
		return p.EnrichModelsDev(models, def.ModelsDevID)
	}
	return nil
}
