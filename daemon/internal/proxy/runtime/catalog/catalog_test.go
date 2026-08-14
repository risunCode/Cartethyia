package catalog

import (
	"errors"
	"testing"

	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/providers/adapters"
)

func testRegistry(t *testing.T) *providers.Registry {
	t.Helper()
	r := providers.NewRegistry()
	r.Register(adapters.NewOpenAIAdapter(adapters.OpenAIAdapterConfig{
		ID: "fixture", DisplayName: "Fixture", BaseURL: "http://127.0.0.1",
		Surfaces: []providers.Surface{providers.SurfaceOpenAIChat},
		Models:   []providers.ProviderModel{providers.Model("native-model", "Native", nil)},
	}))
	return r
}

func TestBuilderResolvesAliasesAndCombos(t *testing.T) {
	b, err := NewBuilder(testRegistry(t))
	if err != nil {
		t.Fatal(err)
	}
	s, err := b.Build(StaticSource{Gen: 4, AliasList: []Alias{{Alias: "friendly", Target: "native-model"}}, CombinationList: []Combination{{ID: "fallback", Members: []string{"friendly"}, Strategy: "fallback"}}})
	if err != nil {
		t.Fatal(err)
	}
	model, err := s.Resolve("friendly")
	if err != nil {
		t.Fatal(err)
	}
	if model.ID != "native-model" || model.ProviderID != "fixture" {
		t.Fatalf("model = %#v", model)
	}
	combo, err := s.Resolve("fallback")
	if err != nil {
		t.Fatal(err)
	}
	if !combo.Combination {
		t.Fatal("combo did not resolve as combination")
	}
	if s.Generation != 4 {
		t.Fatalf("generation = %d", s.Generation)
	}
}

func TestBuilderRejectsAliasCycleAndUnknownCombo(t *testing.T) {
	b, _ := NewBuilder(testRegistry(t))
	_, err := b.Build(StaticSource{AliasList: []Alias{{Alias: "a", Target: "b"}, {Alias: "b", Target: "a"}}})
	if !errors.Is(err, ErrAliasCycle) {
		t.Fatalf("cycle error = %v", err)
	}
	_, err = b.Build(StaticSource{CombinationList: []Combination{{ID: "bad", Members: []string{"missing"}}}})
	if !errors.Is(err, ErrUnknownModel) {
		t.Fatalf("unknown error = %v", err)
	}
}
