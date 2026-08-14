package builtin

import (
	"encoding/json"
	"testing"

	"github.com/cartethyia/daemon/internal/providers"
)

func TestRegisterCustomProviderHonorsProtocolSurfaceHeadersAndKeyPool(t *testing.T) {
	registry := providers.NewRegistry()
	modelsJSON, err := json.Marshal([]providers.ProviderModel{{ID: "custom-model", Capabilities: &providers.ProviderCaps{Surfaces: []providers.Surface{providers.SurfaceOpenAIResponses}, Streaming: true}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := RegisterCustomProvider(registry, CustomProviderInput{
		Slug:           "manual-openai",
		Name:           "Manual OpenAI Responses",
		Type:           "openai-compatible",
		Protocol:       "openai",
		Surface:        "openai-responses",
		BaseURL:        "https://provider.invalid/v1",
		CredentialRefs: []string{"secret:a", "secret:b"},
		ModelsJSON:     modelsJSON,
		HeadersJSON:    []byte(`{"X-Tenant":"tenant-a","Authorization":"Token {{credential}}"}`),
	}); err != nil {
		t.Fatal(err)
	}
	provider, err := registry.Get("manual-openai")
	if err != nil {
		t.Fatal(err)
	}
	target, err := provider.ResolveTarget("custom-model", providers.SurfaceOpenAIResponses)
	if err != nil {
		t.Fatal(err)
	}
	built, err := provider.BuildRequest(providers.RequestEnvelope{Target: target, Body: []byte(`{"input":[]}`)}, "key-a")
	if err != nil {
		t.Fatal(err)
	}
	if built.Endpoint.Path != "responses" || built.Auth.Headers.Get("Authorization") != "Token key-a" || built.Auth.Headers.Get("X-Tenant") != "tenant-a" {
		t.Fatalf("endpoint/auth = %#v / %#v", built.Endpoint, built.Auth.Headers)
	}
}
