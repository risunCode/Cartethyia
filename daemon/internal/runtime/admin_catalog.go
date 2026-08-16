package runtime

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/cartethyia/daemon/internal/accounts"
	"github.com/cartethyia/daemon/internal/providers"
	runtimecatalog "github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
	admin "github.com/cartethyia/daemon/internal/server/admin"
)

// registryCatalogAdminService projects the composed provider registry (and
// the runtime catalog store generation) into the operator catalog contract.
// It exposes only identity, credential-kind, and capability metadata; raw
// credential references and secret material have no representation here.
type registryCatalogAdminService struct {
	registry *providers.Registry
	accounts interface {
		List(context.Context) ([]*accounts.AccountConfig, error)
	}
	catalog interface {
		Status() runtimecatalog.RefreshStatus
	}
}

func (s *registryCatalogAdminService) Providers(ctx context.Context) ([]admin.CatalogProvider, error) {
	if s == nil || s.registry == nil {
		return nil, errors.New("runtime: catalog registry is unavailable")
	}
	counts := s.accountCounts(ctx)
	generation := s.catalogGeneration()
	items := make([]admin.CatalogProvider, 0, s.registry.Size())
	for _, id := range s.registry.IDs() {
		provider, err := s.registry.Get(id)
		if err != nil {
			return nil, fmt.Errorf("runtime: catalog provider %q: %w", id, err)
		}
		if provider == nil {
			continue
		}
		meta := provider.Metadata()
		models := adminCatalogModels(id, provider, generation)
		accountCount := counts[id]
		items = append(items, admin.CatalogProvider{
			ID:              meta.ID,
			DisplayName:     meta.DisplayName,
			Protocol:        string(meta.Protocol),
			CredentialKind:  string(meta.CredentialKind),
			CredentialKinds: adminCredentialKinds(meta),
			Enabled:         true,
			Configured:      adminProviderConfigured(meta, accountCount),
			AccountCount:    accountCount,
			ModelCount:      len(models),
			Generation:      generation,
			AuthScope:       adminCatalogAuthScope(meta),
			Models:          models,
		})
	}
	return items, nil
}

// accountCounts returns enabled account totals per provider. A failing or
// absent account store yields no counts rather than failing the whole catalog
// read; configuration state stays observable either way.
func (s *registryCatalogAdminService) accountCounts(ctx context.Context) map[string]int {
	if s.accounts == nil {
		return nil
	}
	rows, err := s.accounts.List(ctx)
	if err != nil {
		return nil
	}
	counts := make(map[string]int)
	for _, row := range rows {
		if row == nil || !row.Enabled {
			continue
		}
		counts[row.ProviderID]++
	}
	return counts
}

func (s *registryCatalogAdminService) catalogGeneration() uint64 {
	if s.catalog == nil {
		return 0
	}
	return s.catalog.Status().Generation
}

// adminCatalogModels projects a provider's declared models with the bounded
// capability flags the console is allowed to render.
func adminCatalogModels(providerID string, provider providers.Provider, generation uint64) []admin.CatalogModel {
	entries := provider.Models()
	if entries == nil {
		return nil
	}
	declared := entries.List()
	out := make([]admin.CatalogModel, 0, len(declared))
	providerCaps := provider.Capabilities()
	for _, model := range declared {
		if strings.TrimSpace(model.ID) == "" {
			continue
		}
		caps := providerCaps
		if model.Capabilities != nil {
			caps = *model.Capabilities
		}
		display := model.DisplayName
		if display == "" {
			display = model.ID
		}
		out = append(out, admin.CatalogModel{
			ID:           model.ID,
			ProviderID:   providerID,
			DisplayName:  display,
			Enabled:      true,
			Capabilities: map[string]bool{"streaming": caps.Streaming, "reasoning": caps.Reasoning, "toolCalls": caps.ToolCalls, "images": caps.Images, "search": caps.Search, "explicitCache": caps.ExplicitCache, "promptCacheKey": caps.PromptCacheKey},
			Generation:   generation,
		})
	}
	return out
}

// adminProviderConfigured reports whether the provider has credential
// ownership: an explicit credential reference, a credential-free protocol, or
// at least one enabled durable account.
func adminProviderConfigured(meta providers.ProviderMeta, accountCount int) bool {
	if meta.CredentialKind == providers.CredentialNone || strings.TrimSpace(meta.CredentialRef) != "" {
		return true
	}
	return accountCount > 0
}

// adminCatalogAuthScope names the admin scope that manages this provider's
// credentials.
func adminCatalogAuthScope(meta providers.ProviderMeta) string {
	if meta.CredentialKind == providers.CredentialOAuth {
		return "admin:accounts"
	}
	return "admin:config"
}

func adminCredentialKinds(meta providers.ProviderMeta) []string {
	if len(meta.CredentialKinds) == 0 {
		return nil
	}
	out := make([]string, 0, len(meta.CredentialKinds))
	for _, kind := range meta.CredentialKinds {
		if kind != "" {
			out = append(out, string(kind))
		}
	}
	return out
}

var _ admin.CatalogService = (*registryCatalogAdminService)(nil)
