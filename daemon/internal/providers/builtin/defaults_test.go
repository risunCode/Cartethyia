package builtin

import (
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/providers/apikey"
	"github.com/cartethyia/daemon/internal/providers/oauth"
)

func TestDefaultRegistryCanonicalIdentities(t *testing.T) {
	registry, err := DefaultRegistry()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"zenfree", "opencodezen", "opencodego", "xiaomipg", "xiaomitp", "claude", "antigravity"} {
		provider, err := registry.Get(id)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		if len(provider.Models().List()) == 0 {
			t.Fatalf("%s has no handwritten catalog", id)
		}
	}
	for _, id := range []string{"devin", "cursor", "cursorcli", "opencodeft", "opencode-free", "opencode-zen", "opencode-go"} {
		if registry.Has(id) {
			t.Fatalf("unexpected provider alias %q", id)
		}
	}
	payg, _ := registry.Get("xiaomipg")
	tokenPlan, _ := registry.Get("xiaomitp")
	if payg.Metadata().BaseURL == tokenPlan.Metadata().BaseURL {
		t.Fatal("Xiaomi PAYG and token plan share endpoint")
	}
}

func TestDefaultRegistryCoversAllProviderDefinitions(t *testing.T) {
	registry, err := DefaultRegistry()
	if err != nil {
		t.Fatal(err)
	}

	definitions := append(apikey.Definitions(), oauth.Definitions()...)
	definitions = append(definitions, providers.SpecialDefinitions()...)
	seen := make(map[string]struct{}, len(definitions))
	for _, definition := range definitions {
		id := strings.TrimSpace(definition.ID)
		if id == "" {
			t.Fatal("provider definition has empty id")
		}
		if _, duplicate := seen[id]; duplicate {
			t.Fatalf("provider definition %q is registered more than once", id)
		}
		seen[id] = struct{}{}

		provider, err := registry.Get(id)
		if err != nil {
			t.Fatalf("definition %q is not reachable from DefaultRegistry: %v", id, err)
		}
		metadata := provider.Metadata()
		if metadata.ID != id {
			t.Fatalf("definition %q materialized provider id %q", id, metadata.ID)
		}
		if definition.Protocol != "" && metadata.Protocol != definition.Protocol {
			t.Fatalf("provider %q protocol = %q, want %q", id, metadata.Protocol, definition.Protocol)
		}
		if definition.CredentialKind != "" && metadata.CredentialKind != definition.CredentialKind {
			t.Fatalf("provider %q credential kind = %q, want %q", id, metadata.CredentialKind, definition.CredentialKind)
		}
		if len(provider.Models().List()) == 0 {
			t.Fatalf("provider %q materialized without a model catalog", id)
		}
	}

	if got := registry.IDs(); len(got) != len(seen) {
		t.Fatalf("DefaultRegistry has %d provider ids, want %d definitions (%v)", len(got), len(seen), got)
	}
	for id := range seen {
		if !registry.Has(id) {
			t.Fatalf("DefaultRegistry lost registered provider %q", id)
		}
	}
}
