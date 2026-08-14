package adapters

import "testing"

func TestProviderBuildersRejectNullJSONObjects(t *testing.T) {
	openai := NewOpenAIAdapter(OpenAIAdapterConfig{ID: "fixture", BaseURL: "https://provider.invalid", Surfaces: []Surface{SurfaceOpenAIChat}, Models: []ProviderModel{Model("model", "Model", nil)}})
	openaiTarget, err := openai.ResolveTarget("model", SurfaceOpenAIChat)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := openai.BuildRequest(RequestEnvelope{Target: openaiTarget, Body: []byte("null")}, "secret"); err == nil {
		t.Fatal("OpenAI-compatible adapter accepted null body")
	}

	anthropic := NewAnthropicAdapter(AnthropicAdapterConfig{Models: []ProviderModel{Model("model", "Model", nil)}})
	anthropicTarget, err := anthropic.ResolveTarget("model", SurfaceAnthropicMessages)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := anthropic.BuildRequest(RequestEnvelope{Target: anthropicTarget, Body: []byte("null")}, "secret"); err == nil {
		t.Fatal("Anthropic adapter accepted null body")
	}
}
