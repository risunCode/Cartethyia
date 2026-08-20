package services

import (
	"context"
	"testing"
	"time"

	accounts "github.com/cartethyia/daemon/internal/accounts/auth"
	providerbuiltin "github.com/cartethyia/daemon/internal/providers/builtin"
	runtimecatalog "github.com/cartethyia/daemon/internal/router/catalog"
)

type fakeCatalogAccountStore struct{ rows []*accounts.AccountConfig }

func (s fakeCatalogAccountStore) List(context.Context) ([]*accounts.AccountConfig, error) {
	return s.rows, nil
}

type fakeCatalogStatus struct{ generation uint64 }

func (f fakeCatalogStatus) Status() runtimecatalog.RefreshStatus {
	return runtimecatalog.RefreshStatus{Generation: f.generation}
}

func newCatalogTestService(t *testing.T, accounts fakeCatalogAccountStore, generation uint64) *registryCatalogAdminService {
	t.Helper()
	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		t.Fatalf("default registry: %v", err)
	}
	return &registryCatalogAdminService{registry: registry, accounts: accounts, catalog: fakeCatalogStatus{generation: generation}}
}

func TestRegistryCatalogAdminServiceProviders(t *testing.T) {
	service := newCatalogTestService(t, fakeCatalogAccountStore{}, 9)
	providers, err := service.Providers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) == 0 {
		t.Fatal("providers list is empty")
	}
	for _, provider := range providers {
		if provider.ID == "" || provider.DisplayName == "" || provider.CredentialKind == "" {
			t.Fatalf("incomplete provider: %#v", provider)
		}
		if !provider.Enabled || provider.Generation != 9 {
			t.Fatalf("provider flags = %#v", provider)
		}
		if provider.ModelCount != len(provider.Models) {
			t.Fatalf("model count mismatch: %#v", provider)
		}
		for _, model := range provider.Models {
			if model.ID == "" || model.ProviderID != provider.ID || !model.Enabled || model.Generation != 9 {
				t.Fatalf("model = %#v", model)
			}
		}
	}
}

func TestRegistryCatalogAdminServiceAccountCounts(t *testing.T) {
	service := newCatalogTestService(t, fakeCatalogAccountStore{rows: []*accounts.AccountConfig{
		{ID: "a1", ProviderID: "openai", Enabled: true},
		{ID: "a2", ProviderID: "openai", Enabled: true},
		{ID: "a3", ProviderID: "openai"},
	}}, 0)
	providers, err := service.Providers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, provider := range providers {
		if provider.ID != "openai" {
			continue
		}
		if provider.AccountCount != 2 {
			t.Fatalf("account count = %d want 2", provider.AccountCount)
		}
		return
	}
	t.Fatal("openai provider missing from the default registry")
}

func TestRegistryCatalogAdminServiceModelsWithinProviderPayload(t *testing.T) {
	service := newCatalogTestService(t, fakeCatalogAccountStore{}, 4)
	providers, err := service.Providers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) == 0 {
		t.Fatal("providers list is empty")
	}
	if len(providers[0].Models) != providers[0].ModelCount {
		t.Fatalf("models = %#v", providers[0].Models)
	}
}

func TestPostgresDashboardAdminServiceSummaryFillsRuntimeFields(t *testing.T) {
	service := &postgresDashboardAdminService{environment: "production", started: time.Now().UTC().Add(-90 * time.Second)}
	summary, err := service.Summary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Version == "" {
		t.Fatal("version is empty")
	}
	if summary.Environment != "production" {
		t.Fatalf("environment = %q", summary.Environment)
	}
	if summary.Uptime != "1m30s" {
		t.Fatalf("uptime = %q", summary.Uptime)
	}
	if summary.Health["database"] != "postgresql" {
		t.Fatalf("health = %#v", summary.Health)
	}
}

func TestPostgresDashboardAdminServiceDefaultsEnvironment(t *testing.T) {
	service := &postgresDashboardAdminService{}
	summary, err := service.Summary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Environment != "development" || summary.Uptime != "" {
		t.Fatalf("summary = %#v", summary)
	}
}
