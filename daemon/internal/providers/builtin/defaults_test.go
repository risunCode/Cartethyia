package builtin

import "testing"

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
