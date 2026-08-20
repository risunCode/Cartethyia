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
	AdapterAgentRouter AdapterKind = "agentrouter"
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
	// Capabilities is the provider-owned aggregate capability record. It is
	// explicit even when models are loaded from models.dev.
	Capabilities   ProviderCaps
	ModelsDevID    string
	Models         []ProviderModel
	Overrides      CatalogOverrides
}

// CompleteDefinition fills the provider-owned capability record without
// changing catalog entries. Model capabilities are aggregated when handwritten
// models are present; definitions backed by models.dev retain their explicit
// provider fallback until materialization resolves that catalog.
func CompleteDefinition(def ProviderDefinition) ProviderDefinition {
	caps := CloneProviderCaps(def.Capabilities)
	explicitCapabilities := hasCapabilityData(def.Capabilities)
	explicitPolicy := caps.Compatibility.Generation != 0 || caps.Policy.Generation != 0
	for _, model := range def.Models {
		if model.Capabilities != nil && (model.Capabilities.Compatibility.Generation != 0 || model.Capabilities.Policy.Generation != 0) {
			explicitPolicy = true
		}
		if model.Compatibility != nil && model.Compatibility.Generation != 0 {
			explicitPolicy = true
		}
		if model.Policy != nil && model.Policy.Generation != 0 {
			explicitPolicy = true
		}
	}
	if len(caps.Surfaces) == 0 {
		caps.Surfaces = append([]Surface(nil), def.Surfaces...)
	}
	if !caps.Streaming && def.Adapter != "" {
		caps.Streaming = true
	}
	// Preserve the adapter fallback contract while making it provider-owned.
	// Per-model records still remain authoritative for model-level checks.
	if !explicitCapabilities {
		switch def.Adapter {
		case AdapterOpenAI, AdapterCodex:
			caps.ToolCalls = true
			caps.ExplicitCache = true
			caps.PromptCacheKey = true
		case AdapterAnthropic:
			caps.Reasoning = true
			caps.ToolCalls = true
			caps.Images = true
			caps.Search = true
			caps.ExplicitCache = true
			caps.PromptCacheKey = true
		case AdapterGrok:
			caps.Reasoning = true
			caps.ToolCalls = true
			caps.PromptCacheKey = true
		case AdapterAntigravity:
			caps.Reasoning = true
			caps.ToolCalls = true
			caps.Images = true
		case AdapterAgentRouter:
			caps.Reasoning = true
			caps.Images = true
		}
	}
	if len(caps.Auth.CredentialKinds) == 0 && def.CredentialKind != "" && def.CredentialKind != CredentialNone {
		caps.Auth.CredentialKinds = []CredentialKind{def.CredentialKind}
	}
	if !caps.Auth.Required && def.CredentialKind != "" && def.CredentialKind != CredentialNone {
		caps.Auth.Required = true
	}
	if caps.Auth.Required && !caps.Auth.AccountScoped {
		caps.Auth.AccountScoped = true
	}
	if caps.Auth.Refreshable == false && def.CredentialKind == CredentialOAuth {
		caps.Auth.Refreshable = true
	}
	if !caps.Quota.Required && def.CredentialKind != "" && def.CredentialKind != CredentialNone {
		caps.Quota.Required = true
	}
	if caps.Quota.Required {
		caps.Quota.AccountScoped = true
		caps.Quota.UsageTracked = true
	}
	if caps.Classification.AuthScope == "" {
		caps.Classification.AuthScope = FailureScopeAccount
	}
	if caps.Classification.EntitlementScope == "" {
		caps.Classification.EntitlementScope = FailureScopeAccount
	}
	if caps.Classification.QuotaScope == "" {
		caps.Classification.QuotaScope = FailureScopeAccount
	}
	if caps.Classification.CapacityScope == "" {
		caps.Classification.CapacityScope = FailureScopeModel
	}
	if len(def.Models) > 0 {
		caps = aggregateCapabilities(def.Models, caps)
	}
	if !explicitPolicy {
		caps.Compatibility = CompatibilityPolicy{}
		caps.Policy = CompatibilityPolicy{}
	}
	def.Capabilities = CloneProviderCaps(caps)
	return def
}

func hasCapabilityData(caps ProviderCaps) bool {
	return len(caps.Surfaces) > 0 || caps.Streaming || caps.Reasoning || caps.ToolCalls ||
		caps.Images || len(caps.MediaGeneration) > 0 || caps.ExplicitCache || caps.PromptCacheKey ||
		caps.Search || caps.Batch || caps.Auth.Required || len(caps.Auth.CredentialKinds) > 0 ||
		caps.Auth.Refreshable || caps.Auth.AccountScoped || caps.Quota.Required ||
		caps.Quota.AccountScoped || caps.Quota.UsageTracked ||
		len(caps.Classification.AuthMarkers) > 0 || len(caps.Classification.EntitlementMarkers) > 0 ||
		len(caps.Classification.QuotaMarkers) > 0 || len(caps.Classification.CapacityMarkers) > 0 ||
		caps.Classification.AuthScope != "" || caps.Classification.EntitlementScope != "" ||
		caps.Classification.QuotaScope != "" || caps.Classification.CapacityScope != "" ||
		caps.Compatibility.Generation != 0 || caps.Policy.Generation != 0
}

// CompleteProviderDefinition is the descriptive alias for callers that use
// the full provider-definition terminology.
func CompleteProviderDefinition(def ProviderDefinition) ProviderDefinition {
	return CompleteDefinition(def)
}

// OverrideCapabilities decorates a provider with an explicit provider-owned
// capability record. It delegates all request and response behavior unchanged.
func OverrideCapabilities(provider Provider, caps ProviderCaps) Provider {
	if provider == nil {
		return nil
	}
	// Keep adapter-owned compatibility behavior until policy ownership is
	// migrated separately. Capability metadata is replaced, but request
	// encoding must remain byte-for-byte compatible with the adapter.
	actual := provider.Capabilities()
	if caps.Compatibility.Generation == 0 {
		caps.Compatibility = actual.Compatibility.Clone()
	}
	if caps.Policy.Generation == 0 {
		caps.Policy = actual.Policy.Clone()
	}
	return &capabilityOverride{Provider: provider, caps: CloneProviderCaps(caps)}
}

type capabilityOverride struct {
	Provider
	caps ProviderCaps
}

func (p *capabilityOverride) Capabilities() ProviderCaps {
	return CloneProviderCaps(p.caps)
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
	Compatibility    *CompatibilityPolicy
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
		if overrides.Compatibility != nil {
			policy := overrides.Compatibility.Clone()
			model.Compatibility = &policy
		}
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
			if overrides.DisableVision {
				caps.Compatibility.Media.Kinds = withoutMediaKind(caps.Compatibility.Media.Kinds, MediaImage)
			}
			if overrides.DisableReasoning {
				caps.Compatibility.Reasoning.Enabled = false
				caps.Compatibility.Reasoning.Formats = nil
			}
			if overrides.DisableToolCalls {
				caps.Compatibility.Tools.SupportedKinds = nil
			}
			model.Capabilities = &caps
		}
		if model.Compatibility != nil {
			policy := model.Compatibility.Clone()
			if overrides.DisableVision { policy.Media.Kinds = withoutMediaKind(policy.Media.Kinds, MediaImage) }
			if overrides.DisableReasoning { policy.Reasoning.Enabled = false; policy.Reasoning.Formats = nil }
			if overrides.DisableToolCalls { policy.Tools.SupportedKinds = nil }
			model.Compatibility = &policy
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

func withoutMediaKind(values []MediaKind, unwanted MediaKind) []MediaKind {
	result := make([]MediaKind, 0, len(values))
	for _, value := range values {
		if value != unwanted { result = append(result, value) }
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
	Compatibility     *CompatibilityPolicy
	Policy            *CompatibilityPolicy
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
			Compatibility: clonePolicyPtr(model.Compatibility), Policy: clonePolicyPtr(model.Policy),
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
