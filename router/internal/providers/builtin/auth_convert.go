package builtin

import (
	"github.com/cartethyia/daemon/internal/accounts/auth"
	"github.com/cartethyia/daemon/internal/providers"
)

// fromAuthDefinition converts the account-owned OAuth descriptor into the
// provider-owned runtime descriptor at the composition root. Keeping this
// conversion here prevents the account package from depending on provider
// adapters or catalog implementation types.
func fromAuthDefinition(def auth.ProviderDefinition) providers.ProviderDefinition {
	out := providers.ProviderDefinition{
		ID:             def.ID,
		DisplayName:    def.DisplayName,
		Protocol:       providers.Protocol(def.Protocol),
		Adapter:        providers.AdapterKind(def.Adapter),
		CredentialKind: providers.CredentialKind(def.CredentialKind),
		CredentialRef:  def.CredentialRef,
		CredentialURL:  def.CredentialURL,
		AuthMode:       def.AuthMode,
		BaseURL:        def.BaseURL,
		ModelsDevID:    def.ModelsDevID,
		Overrides: providers.CatalogOverrides{
			AllowedModelIDs: append([]string(nil), def.Overrides.AllowedModelIDs...),
		},
	}
	out.Surfaces = make([]providers.Surface, len(def.Surfaces))
	for i, surface := range def.Surfaces {
		out.Surfaces[i] = providers.Surface(surface)
	}
	out.Models = make([]providers.ProviderModel, len(def.Models))
	for i, model := range def.Models {
		out.Models[i] = providers.ProviderModel{
			ID:          model.ID,
			DisplayName: model.DisplayName,
			UpstreamID:  model.UpstreamID,
		}
		if model.Capabilities != nil {
			caps := model.Capabilities
			converted := providers.ProviderCaps{
				Streaming: caps.Streaming,
				Reasoning: caps.Reasoning,
				ToolCalls: caps.ToolCalls,
				Images:    caps.Images,
			}
			converted.Surfaces = make([]providers.Surface, len(caps.Surfaces))
			for j, surface := range caps.Surfaces {
				converted.Surfaces[j] = providers.Surface(surface)
			}
			out.Models[i].Capabilities = &converted
		}
	}
	return out
}
