package providers

import "testing"

func TestModelsDevEnrichesHandwrittenCatalogOnly(t *testing.T) {
	caps := &ProviderCaps{Reasoning: true, ToolCalls: true, Images: true}
	models := HandwrittenModels(HandwrittenModel{
		ID: "gpt-5.5", DisplayName: "Handwritten GPT", Capabilities: caps,
		ContextWindow: 777, MaxOutput: 888, ModelsDevProvider: "openai",
	})
	models = EnrichModelsDev(models, "openai")
	if len(models) != 1 || models[0].ID != "gpt-5.5" || models[0].DisplayName != "Handwritten GPT" {
		t.Fatalf("handwritten catalog was replaced: %#v", models)
	}
	if models[0].Metadata.ContextWindow != 777 || models[0].Metadata.MaxOutput != 888 {
		t.Fatalf("handwritten hard limits were replaced: %#v", models[0].Metadata)
	}
	if !models[0].Capabilities.Images || !models[0].Capabilities.Reasoning {
		t.Fatal("models.dev changed handwritten capabilities")
	}
}

func TestModelsDevFillsMissingNumericMetadata(t *testing.T) {
	models := HandwrittenModels(HandwrittenModel{ID: "gpt-5.5", DisplayName: "GPT"})
	models = EnrichModelsDev(models, "openai")
	if models[0].Metadata.ContextWindow == 0 || models[0].Metadata.Pricing.Input == 0 {
		t.Fatalf("models.dev numeric enrichment missing: %#v", models[0].Metadata)
	}
}

func TestModelsWithoutModelsDevMatchKeepFallback(t *testing.T) {
	models := HandwrittenModels(HandwrittenModel{ID: "claude-fable-5", DisplayName: "Fable", ContextWindow: 200000, MaxOutput: 64000})
	models = EnrichModelsDev(models, "anthropic")
	if models[0].Metadata.ContextWindow != 200000 || models[0].Metadata.MaxOutput != 64000 {
		t.Fatalf("fallback metadata was lost: %#v", models[0].Metadata)
	}
}
