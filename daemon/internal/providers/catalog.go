package providers

import (
	"sort"
)

// AdapterKind selects the shared wire adapter used by a provider definition.
type AdapterKind string

const (
	AdapterOpenAI      AdapterKind = "openai"
	AdapterAnthropic   AdapterKind = "anthropic"
	AdapterGrok        AdapterKind = "grok"
	AdapterCodex       AdapterKind = "codex"
	AdapterAntigravity AdapterKind = "antigravity"
)

// ProviderDefinition is the explicit provider-owned configuration. A provider
// file owns identity, endpoint, credential kind, catalog source, and only the
// deviations from models.dev required by its upstream contract.
type ProviderDefinition struct {
	ID             string
	DisplayName    string
	Protocol       Protocol
	Adapter        AdapterKind
	CredentialKind CredentialKind
	CredentialRef  string
	CredentialURL  string
	AuthMode       string
	BaseURL        string
	Surfaces       []Surface
	ModelsDevID    string
	Models         []ProviderModel
	Overrides      CatalogOverrides
}

// CatalogOverrides describes provider restrictions over models.dev metadata.
type CatalogOverrides struct {
	MaxContext       int
	MaxOutput        int
	DisableVision    bool
	DisableReasoning bool
	DisableToolCalls bool
	AllowedModelIDs  []string
	HiddenModelIDs   []string
}

func resolveDefinitionModels(def ProviderDefinition) []ProviderModel {
	if len(def.Models) > 0 {
		models := append([]ProviderModel(nil), def.Models...)
		for index := range models {
			if models[index].Metadata.Source == "" {
				models[index].Metadata.Source = "provider"
			}
		}
		return EnrichModelsDev(models, def.ModelsDevID)
	}
	models := LoadModelsDevModels(def.ModelsDevID, def.Surfaces)
	return applyCatalogOverrides(models, def.Overrides)
}

func missingModels(source, fallback []ProviderModel) []ProviderModel {
	seen := make(map[string]struct{}, len(source))
	for _, model := range source {
		seen[model.ID] = struct{}{}
	}
	result := make([]ProviderModel, 0, len(fallback))
	for _, model := range fallback {
		if _, ok := seen[model.ID]; !ok {
			result = append(result, model)
		}
	}
	return result
}

func applyCatalogOverrides(models []ProviderModel, overrides CatalogOverrides) []ProviderModel {
	hidden := make(map[string]struct{}, len(overrides.HiddenModelIDs))
	for _, id := range overrides.HiddenModelIDs {
		hidden[id] = struct{}{}
	}
	allowed := make(map[string]struct{}, len(overrides.AllowedModelIDs))
	for _, id := range overrides.AllowedModelIDs {
		allowed[id] = struct{}{}
	}
	result := make([]ProviderModel, 0, len(models))
	for _, model := range models {
		if _, ok := hidden[model.ID]; ok {
			continue
		}
		if len(allowed) > 0 {
			if _, ok := allowed[model.ID]; !ok {
				continue
			}
		}
		model.Metadata = applyMetadataOverrides(model.Metadata, overrides)
		if model.Capabilities != nil {
			caps := *model.Capabilities
			if overrides.DisableVision {
				caps.Images = false
			}
			if overrides.DisableReasoning {
				caps.Reasoning = false
			}
			if overrides.DisableToolCalls {
				caps.ToolCalls = false
			}
			model.Capabilities = &caps
		}
		result = append(result, model)
	}
	return result
}

func applyMetadataOverrides(metadata ModelMetadata, overrides CatalogOverrides) ModelMetadata {
	if overrides.MaxContext > 0 && (metadata.ContextWindow == 0 || overrides.MaxContext < metadata.ContextWindow) {
		metadata.ContextWindow = overrides.MaxContext
	}
	if overrides.MaxOutput > 0 && (metadata.MaxOutput == 0 || overrides.MaxOutput < metadata.MaxOutput) {
		metadata.MaxOutput = overrides.MaxOutput
	}
	if overrides.DisableVision {
		metadata.Modalities.Input = withoutModality(metadata.Modalities.Input, "image")
	}
	if overrides.DisableReasoning {
		metadata.Reasoning.Enabled = false
		metadata.Reasoning.Options = nil
	}
	return metadata
}

func withoutModality(values []string, unwanted string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != unwanted {
			result = append(result, value)
		}
	}
	return result
}

func sortedModelIDs(models []ProviderModel) []string {
	ids := make([]string, 0, len(models))
	for _, model := range models {
		ids = append(ids, model.ID)
	}
	sort.Strings(ids)
	return ids
}

// HandwrittenModel is the provider-owned catalog entry. models.dev enriches
// numeric metadata only; it never creates, removes, or changes capabilities.
type HandwrittenModel struct {
	ID                string
	DisplayName       string
	UpstreamID        string
	Capabilities      *ProviderCaps
	Surfaces          []Surface
	Reasoning         *bool
	ToolCalls         *bool
	ContextWindow     int
	MaxOutput         int
	Pricing           *ModelPricing
	ModelsDevProvider string
	ModelsDevModel    string
}

func HandwrittenModels(models ...HandwrittenModel) []ProviderModel {
	result := make([]ProviderModel, 0, len(models))
	for _, model := range models {
		result = append(result, ProviderModel{
			ID: model.ID, DisplayName: model.DisplayName, UpstreamID: model.UpstreamID,
			Capabilities: model.Capabilities, Surfaces: model.Surfaces,
			Reasoning: model.Reasoning, ToolCalls: model.ToolCalls,
			ModelsDevProvider: model.ModelsDevProvider, ModelsDevModel: model.ModelsDevModel,
			ContextWindow: model.ContextWindow, MaxOutput: model.MaxOutput, Pricing: model.Pricing,
			Metadata: ModelMetadata{
				ContextWindow: model.ContextWindow, MaxOutput: model.MaxOutput,
				Pricing: derefPricing(model.Pricing), Source: "provider",
			},
		})
	}
	return result
}

func derefPricing(pricing *ModelPricing) ModelPricing {
	if pricing == nil {
		return ModelPricing{}
	}
	return *pricing
}

// EnrichModelsDev fills only missing pricing and limits for an already declared
// provider catalog. Exact model matches use ModelsDevModel when supplied,
// otherwise the handwritten ID. Provider limits are hard caps.
func EnrichModelsDev(models []ProviderModel, providerID string) []ProviderModel {
	for index := range models {
		if models[index].Metadata.ContextWindow == 0 {
			models[index].Metadata.ContextWindow = models[index].ContextWindow
		}
		if models[index].Metadata.MaxOutput == 0 {
			models[index].Metadata.MaxOutput = models[index].MaxOutput
		}
		if models[index].Metadata.Pricing == (ModelPricing{}) && models[index].Pricing != nil {
			models[index].Metadata.Pricing = *models[index].Pricing
		}
		modelID := models[index].ID
		modelsDevID := models[index].ModelsDevProvider
		if modelsDevID == "" {
			modelsDevID = providerID
		}
		modelsDevModelID := models[index].ModelsDevModel
		if modelsDevModelID == "" {
			modelsDevModelID = modelID
		}
		match := LoadModelsDevModel(modelsDevID, modelsDevModelID)
		if match == nil {
			continue
		}
		metadata := &models[index].Metadata
		if metadata.ContextWindow == 0 {
			metadata.ContextWindow = match.ContextWindow
		}
		if metadata.MaxOutput == 0 {
			metadata.MaxOutput = match.MaxOutput
		}
		if metadata.Pricing == (ModelPricing{}) {
			metadata.Pricing = match.Pricing
		}
		metadata.Source = "provider+models.dev"
	}
	return models
}
