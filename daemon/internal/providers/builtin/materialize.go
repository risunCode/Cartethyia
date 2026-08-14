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
	switch def.Adapter {
	case p.AdapterOpenAI:
		return adapters.NewOpenAIAdapter(adapters.OpenAIAdapterConfig{
			ID: def.ID, DisplayName: def.DisplayName, BaseURL: def.BaseURL,
			CredentialRef: def.CredentialRef, CredentialKind: def.CredentialKind,
			CredentialURL: def.CredentialURL, Surfaces: def.Surfaces, Models: models,
		}), nil
	case p.AdapterAnthropic:
		return adapters.NewAnthropicAdapter(adapters.AnthropicAdapterConfig{
			ID: def.ID, DisplayName: def.DisplayName, BaseURL: def.BaseURL,
			CredentialRef: def.CredentialRef, CredentialKind: def.CredentialKind,
			Auth: def.AuthMode, Models: models,
		}), nil
	case p.AdapterGrok:
		return adapters.NewGrokBuildAdapter(adapters.GrokBuildConfig{
			ID: def.ID, DisplayName: def.DisplayName, BaseURL: def.BaseURL,
			CredentialRef: def.CredentialRef, CredentialKind: def.CredentialKind,
			Models: models,
		}), nil
	case p.AdapterCodex:
		return adapters.NewCodexAdapter(adapters.OpenAIAdapterConfig{
			ID: def.ID, DisplayName: def.DisplayName, BaseURL: def.BaseURL,
			CredentialRef: def.CredentialRef, CredentialKind: def.CredentialKind,
			CredentialURL: def.CredentialURL, Surfaces: def.Surfaces, Models: models,
		}), nil
	case p.AdapterAntigravity:
		return adapters.NewAntigravityAdapter(adapters.OpenAIAdapterConfig{
			ID: def.ID, DisplayName: def.DisplayName, BaseURL: def.BaseURL,
			CredentialRef: def.CredentialRef, CredentialKind: def.CredentialKind,
			CredentialURL: def.CredentialURL, Surfaces: def.Surfaces, Models: models,
		}), nil
	default:
		return nil, fmt.Errorf("provider %q has unsupported adapter %q", def.ID, def.Adapter)
	}
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
