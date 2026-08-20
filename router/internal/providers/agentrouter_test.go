package providers

import (
	"strings"
	"testing"
)

func TestProviderConvenienceAndErrors(t *testing.T) {
	caps := ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}}
	if !HasCapability(caps, SurfaceOpenAIChat) || HasCapability(caps, SurfaceAnthropicMessages) {
		t.Fatal("HasCapability mismatch")
	}
	m := ModelWithUpstream("client", "wire", "Client", &caps)
	if m.UpstreamID != "wire" {
		t.Fatalf("unexpected upstream model: %#v", m)
	}
	policy, err := NewCompatibilityPolicy(1)
	if err != nil {
		t.Fatal(err)
	}
	m = ModelWithCompatibility("id", "name", nil, policy)
	if m.Compatibility == nil || m.EffectiveCompatibility(ProviderCaps{}).Generation != 1 {
		t.Fatal("model compatibility was not retained")
	}
	if _, err := NewCompatibilityPolicy(0); err == nil {
		t.Fatal("zero policy generation accepted")
	}
	var unknown *UnknownModelError
	unknown = &UnknownModelError{ProviderID: "x", ModelID: "y"}
	if !strings.Contains(unknown.Error(), "x") || !strings.Contains(unknown.Error(), "y") {
		t.Fatalf("unknown model error mismatch: %v", unknown)
	}
}
