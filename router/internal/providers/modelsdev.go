package providers

import (
	_ "embed"
	"encoding/json"
	"strings"
	"sync"
)

//go:embed models.dev.json
var modelsDevSnapshot []byte

type modelsDevProvider struct {
	Models map[string]modelsDevModel `json:"models"`
}

type modelsDevModel struct {
	ID               string               `json:"id"`
	Name             string               `json:"name"`
	Reasoning        bool                 `json:"reasoning"`
	ReasoningOptions []modelsDevReasoning `json:"reasoning_options"`
	ToolCall         bool                 `json:"tool_call"`
	StructuredOutput bool                 `json:"structured_output"`
	Attachment       bool                 `json:"attachment"`
	Modalities       modelsDevModalities  `json:"modalities"`
	Limit            modelsDevLimit       `json:"limit"`
	Cost             modelsDevCost        `json:"cost"`
	Status           string               `json:"status"`
	ReleaseDate      string               `json:"release_date"`
	LastUpdated      string               `json:"last_updated"`
}

type modelsDevReasoning struct {
	Type   string   `json:"type"`
	Values []string `json:"values"`
}

type modelsDevModalities struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

type modelsDevLimit struct {
	Context int `json:"context"`
	Output  int `json:"output"`
}

type modelsDevCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cache_read"`
	CacheWrite float64 `json:"cache_write"`
}

var (
	modelsDevOnce sync.Once
	modelsDevData map[string]modelsDevProvider
)

// LoadModelsDevModels returns all non-deprecated models for providerID. The
// embedded JSON is a last-known-good snapshot so provider startup never needs
// network I/O; refresh tooling can replace the snapshot deliberately.
func LoadModelsDevModels(providerID string, surfaces []Surface) []ProviderModel {
	modelsDevOnce.Do(loadModelsDevSnapshot)
	provider, ok := modelsDevData[providerID]
	if !ok {
		return nil
	}
	result := make([]ProviderModel, 0, len(provider.Models))
	for modelID, model := range provider.Models {
		if model.Status == "deprecated" {
			continue
		}
		id := model.ID
		if id == "" {
			id = modelID
		}
		caps := modelCaps(model, surfaces)
		result = append(result, ProviderModel{
			ID: id, DisplayName: model.Name, Capabilities: caps,
			Surfaces:  append([]Surface(nil), surfaces...),
			Reasoning: boolPointer(model.Reasoning), ToolCalls: boolPointer(model.ToolCall),
			Metadata: ModelMetadata{
				ContextWindow: model.Limit.Context, MaxOutput: model.Limit.Output,
				Pricing:    ModelPricing{Input: model.Cost.Input, Output: model.Cost.Output, CacheRead: model.Cost.CacheRead, CacheWrite: model.Cost.CacheWrite},
				Modalities: ModelModalities{Input: append([]string(nil), model.Modalities.Input...), Output: append([]string(nil), model.Modalities.Output...)},
				Reasoning:  ModelReasoning{Enabled: model.Reasoning, Options: reasoningValues(model.ReasoningOptions)}, Source: "models.dev",
			},
		})
	}
	return result
}

// LoadModelsDevModel returns metadata for one exact provider/model match.
func LoadModelsDevModel(providerID, modelID string) *ModelMetadata {
	modelsDevOnce.Do(loadModelsDevSnapshot)
	provider, ok := modelsDevData[providerID]
	if !ok {
		return nil
	}
	model, ok := provider.Models[modelID]
	if !ok || model.Status == "deprecated" {
		return nil
	}
	return &ModelMetadata{
		ContextWindow: model.Limit.Context,
		MaxOutput:     model.Limit.Output,
		Pricing:       ModelPricing{Input: model.Cost.Input, Output: model.Cost.Output, CacheRead: model.Cost.CacheRead, CacheWrite: model.Cost.CacheWrite},
		Modalities:    ModelModalities{Input: append([]string(nil), model.Modalities.Input...), Output: append([]string(nil), model.Modalities.Output...)},
		Reasoning:     ModelReasoning{Enabled: model.Reasoning, Options: reasoningValues(model.ReasoningOptions)},
		Source:        "models.dev",
	}
}

func loadModelsDevSnapshot() {
	modelsDevData = make(map[string]modelsDevProvider)
	if err := json.Unmarshal(modelsDevSnapshot, &modelsDevData); err != nil {
		modelsDevData = map[string]modelsDevProvider{}
	}
}

func modelCaps(model modelsDevModel, surfaces []Surface) *ProviderCaps {
	caps := &ProviderCaps{
		Surfaces:  append([]Surface(nil), surfaces...),
		Streaming: true,
		Reasoning: model.Reasoning,
		ToolCalls: model.ToolCall,
		Images:    hasModality(model.Modalities.Input, "image") || model.Attachment,
	}
	for _, surface := range surfaces {
		if surface == SurfaceWebSearch {
			caps.Search = true
		}
	}
	return caps
}

func reasoningValues(options []modelsDevReasoning) []string {
	values := make([]string, 0)
	for _, option := range options {
		values = append(values, option.Values...)
		if len(option.Values) == 0 && option.Type != "" {
			values = append(values, option.Type)
		}
	}
	return values
}

func hasModality(values []string, wanted string) bool {
	for _, value := range values {
		if strings.EqualFold(value, wanted) {
			return true
		}
	}
	return false
}

func boolPointer(value bool) *bool {
	return &value
}
