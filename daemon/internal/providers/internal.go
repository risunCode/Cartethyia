package providers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"unicode"
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
	merged.MediaGeneration = dedupeStrings(media)
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

func dedupeStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// classifyByStatus is the default response classifier. It maps upstream
// status codes to routing buckets and is the only classifier the built-in
// adapters need; family-specific adapters can override it.
func classifyByStatus(statusCode int, body []byte) ClassifiedResponse {
	msg := summarize(body)
	signal := bodySignal(body)
	switch {
	case statusCode >= 200 && statusCode < 300:
		return ClassifiedResponse{StatusCode: statusCode, Category: CategorySuccess, Message: msg}
	case statusCode == 401:
		return ClassifiedResponse{StatusCode: statusCode, Category: CategoryAuth, Message: msg}
	case statusCode == 403:
		if signal == "content_policy" {
			return ClassifiedResponse{StatusCode: statusCode, Category: CategoryContentPolicy, Message: "provider content policy refusal"}
		}
		return ClassifiedResponse{StatusCode: statusCode, Category: CategoryAuth, Message: msg}
	case statusCode == 408, statusCode == 425:
		return ClassifiedResponse{StatusCode: statusCode, Category: CategoryRateLimit, Retryable: true, Message: msg}
	case statusCode == 429:
		if signal == "quota" {
			return ClassifiedResponse{StatusCode: statusCode, Category: CategoryQuota, Retryable: true, Message: "provider quota exhausted"}
		}
		return ClassifiedResponse{StatusCode: statusCode, Category: CategoryRateLimit, Retryable: true, Message: msg}
	case statusCode == 402:
		return ClassifiedResponse{StatusCode: statusCode, Category: CategoryQuota, Retryable: false, Message: msg}
	case statusCode >= 500:
		return ClassifiedResponse{StatusCode: statusCode, Category: CategoryTransient, Retryable: true, Message: msg}
	case statusCode >= 400:
		return ClassifiedResponse{StatusCode: statusCode, Category: CategoryInvalidRequest, Message: msg}
	default:
		return ClassifiedResponse{StatusCode: statusCode, Category: CategoryFatal, Message: msg}
	}
}

// bodySignal recognizes only bounded, category-like provider markers. It
// never returns body text and therefore cannot accidentally expose credentials,
// prompts, cookies, or opaque upstream payloads in classification metadata.
func bodySignal(body []byte) string {
	const maxScan = 16 * 1024
	raw := body
	if len(raw) > maxScan {
		raw = raw[:maxScan]
	}
	lower := strings.ToLower(string(raw))
	switch {
	case strings.Contains(lower, "content_policy"),
		strings.Contains(lower, "content policy"),
		strings.Contains(lower, "safety_violation"),
		strings.Contains(lower, "blocked content"),
		strings.Contains(lower, "policy violation"):
		return "content_policy"
	case strings.Contains(lower, "quota"),
		strings.Contains(lower, "usage_limit"),
		strings.Contains(lower, "insufficient_quota"),
		strings.Contains(lower, "billing_hard_limit"),
		strings.Contains(lower, "credit exhausted"),
		strings.Contains(lower, "resource_exhausted"):
		return "quota"
	default:
		return ""
	}
}

// summarize extracts a small structured error marker rather than returning a
// raw provider body. Provider messages frequently echo request data, so even
// bounded body truncation is not a secret-safe contract.
func summarize(body []byte) string {
	const max = 96
	if len(body) == 0 {
		return ""
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil || root == nil {
		return ""
	}
	var marker string
	for _, key := range []string{"code", "type", "status", "reason"} {
		if value, ok := root[key].(string); ok {
			marker = value
			break
		}
	}
	if nested, ok := root["error"].(map[string]any); ok {
		for _, key := range []string{"code", "type", "status", "reason"} {
			if value, ok := nested[key].(string); ok {
				marker = value
				break
			}
		}
	}
	marker = safeMarker(marker, max)
	if marker == "" {
		return ""
	}
	return marker
}

func safeMarker(value string, max int) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > max {
		return ""
	}
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune("_-.:/", r) {
			continue
		}
		return ""
	}
	return value
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
