package adapters

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/cartethyia/daemon/internal/providers"
)

func providerCredentialRef(id string) string {
	return "provider:" + id
}

func decodeJSONObject(body []byte) (map[string]any, error) {
	var value map[string]any
	if err := json.Unmarshal(body, &value); err != nil {
		return nil, err
	}
	if value == nil {
		return nil, errors.New("body must be a JSON object")
	}
	return value, nil
}

// staticCatalog is a ProviderModelCatalog backed by an in-memory slice. The
// built-in adapters are all eagerly constructed, so a map is sufficient.
type staticCatalog struct {
	models []ProviderModel
	byID   map[string]ProviderModel
}

func newStaticCatalog(models []ProviderModel) *staticCatalog {
	byID := make(map[string]ProviderModel, len(models))
	for _, m := range models {
		byID[m.ID] = m
	}
	return &staticCatalog{models: append([]ProviderModel(nil), models...), byID: byID}
}

// List implements ProviderModelCatalog.
func (c *staticCatalog) List() []ProviderModel {
	out := make([]ProviderModel, len(c.models))
	copy(out, c.models)
	return out
}

// Get implements ProviderModelCatalog.
func (c *staticCatalog) Get(modelID string) *ProviderModel {
	m, ok := c.byID[modelID]
	if !ok {
		return nil
	}
	mm := m
	return &mm
}

// aggregateCapabilities reduces a slice of model entries to a single
// capability record. It mirrors aggregateCapabilities() in the legacy
// src.old/open-sse/transport/catalog.ts: each capability flag is true iff
// at least one model enables it, and Surfaces is the union across models.
func aggregateCapabilities(models []ProviderModel, fallback ProviderCaps) ProviderCaps {
	if len(models) == 0 {
		return fallback
	}
	merged := fallback
	merged.Surfaces = dedupeSurfaces(append([]Surface(nil), fallback.Surfaces...))
	// Start the merge with a fresh streaming flag; the fallback decides
	// the default, and any per-model override wins.
	streaming := fallback.Streaming
	reasoning := fallback.Reasoning
	toolCalls := fallback.ToolCalls
	images := fallback.Images
	explicit := fallback.ExplicitCache
	promptKey := fallback.PromptCacheKey
	search := fallback.Search
	media := append([]string(nil), fallback.MediaGeneration...)
	for _, m := range models {
		if m.Capabilities == nil {
			continue
		}
		c := *m.Capabilities
		merged.Surfaces = dedupeSurfaces(append(merged.Surfaces, c.Surfaces...))
		if c.Streaming {
			streaming = true
		}
		if c.Reasoning {
			reasoning = true
		}
		if c.ToolCalls {
			toolCalls = true
		}
		if c.Images {
			images = true
		}
		if c.ExplicitCache {
			explicit = true
		}
		if c.PromptCacheKey {
			promptKey = true
		}
		if c.Search {
			search = true
		}
		media = append(media, c.MediaGeneration...)
	}
	merged.Streaming = streaming
	merged.Reasoning = reasoning
	merged.ToolCalls = toolCalls
	merged.Images = images
	merged.ExplicitCache = explicit
	merged.PromptCacheKey = promptKey
	merged.Search = search
	merged.MediaGeneration = providers.DedupeStrings(media)
	return merged
}

func dedupeSurfaces(in []Surface) []Surface {
	seen := make(map[Surface]struct{}, len(in))
	out := make([]Surface, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

func classifyByStatus(evidence ResponseEvidence) ClassifiedResponse {
	return ClassifyResponseEvidence(evidence)
}

// bytesTrim is a small helper that returns body with surrounding ASCII
// whitespace removed. Empty after trim means "no body".
func bytesTrim(body []byte) []byte {
	return []byte(strings.TrimSpace(string(body)))
}

// randomUUID returns a 32-hex-character random identifier. We use a
// cryptographically random source rather than time so a Provider built for
// a test does not return a deterministic value.
func randomUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Fall back to a stable string; the auth gate won't accept the
		// request, which is the safe outcome on entropy failure.
		return "00000000000000000000000000000000"
	}
	return hex.EncodeToString(b[:])
}
