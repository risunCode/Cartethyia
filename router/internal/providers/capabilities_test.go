package providers

import "testing"

func TestCompleteDefinitionPublishesExplicitCapabilities(t *testing.T) {
	def := CompleteDefinition(ProviderDefinition{
		ID:             "fixture",
		Adapter:        AdapterOpenAI,
		CredentialKind: CredentialOAuth,
		Surfaces:       []Surface{SurfaceOpenAIChat},
		Models: []ProviderModel{{
			ID: "model",
			Capabilities: &ProviderCaps{
				Surfaces:  []Surface{SurfaceOpenAIChat},
				Streaming: true,
				ToolCalls: true,
				Batch:     true,
			},
		}},
	})
	if len(def.Capabilities.Surfaces) != 1 || !def.Capabilities.Streaming ||
		!def.Capabilities.ToolCalls || !def.Capabilities.Batch {
		t.Fatalf("capabilities = %#v", def.Capabilities)
	}
	if !def.Capabilities.Auth.Required || !def.Capabilities.Auth.Refreshable ||
		!def.Capabilities.Quota.Required {
		t.Fatalf("requirements = %#v", def.Capabilities)
	}
	if def.Capabilities.Classification.QuotaScope != FailureScopeAccount {
		t.Fatalf("quota classification scope = %q", def.Capabilities.Classification.QuotaScope)
	}
}

func TestRegistryCapabilitiesDoesNotMaterializeLazyProvider(t *testing.T) {
	registry := NewRegistry()
	loaded := false
	caps := ProviderCaps{Surfaces: []Surface{SurfaceImages}, Streaming: true, Images: true}
	if err := registry.RegisterLazy(LoaderFactory{
		ID: "lazy", Capabilities: caps, Load: func() (Provider, error) {
			loaded = true
			return nil, nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	got, err := registry.Capabilities("lazy")
	if err != nil {
		t.Fatal(err)
	}
	if loaded {
		t.Fatal("capability lookup materialized lazy provider")
	}
	if !HasCapability(got, SurfaceImages) || !got.Images {
		t.Fatalf("capabilities = %#v", got)
	}
}
