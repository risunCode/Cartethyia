package providers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	domaincontracts "github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
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
	owned := make([]ProviderModel, 0, len(models))
	for _, m := range models {
		m.Compatibility = clonePolicyPtr(m.Compatibility)
		m.Policy = clonePolicyPtr(m.Policy)
		if m.Capabilities != nil {
			caps := *m.Capabilities
			caps.Compatibility = caps.Compatibility.Clone()
			caps.Policy = caps.Policy.Clone()
			m.Capabilities = &caps
		}
		owned = append(owned, m)
		byID[m.ID] = m
	}
	return &staticCatalog{models: owned, byID: byID}
}

// List implements ProviderModelCatalog.
func (c *staticCatalog) List() []ProviderModel {
	out := make([]ProviderModel, len(c.models))
	copy(out, c.models)
	for i := range out {
		out[i].Compatibility = clonePolicyPtr(out[i].Compatibility)
		out[i].Policy = clonePolicyPtr(out[i].Policy)
		if out[i].Capabilities != nil { caps := *out[i].Capabilities; caps.Compatibility = caps.Compatibility.Clone(); caps.Policy = caps.Policy.Clone(); out[i].Capabilities = &caps }
	}
	return out
}

// Get implements ProviderModelCatalog.
func (c *staticCatalog) Get(modelID string) *ProviderModel {
	m, ok := c.byID[modelID]
	if !ok {
		return nil
	}
	mm := m
	mm.Compatibility = clonePolicyPtr(mm.Compatibility)
	mm.Policy = clonePolicyPtr(mm.Policy)
	if mm.Capabilities != nil { caps := *mm.Capabilities; caps.Compatibility = caps.Compatibility.Clone(); caps.Policy = caps.Policy.Clone(); mm.Capabilities = &caps }
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
	policy := fallback.Compatibility.Clone()
	if policy.Generation == 0 && fallback.Policy.Generation != 0 { policy = fallback.Policy.Clone() }
	if policy.Generation == 0 {
		policy = LegacyCompatibilityPolicy(fallback)
	}
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
		policy = mergeCompatibilityPolicies(policy, EffectiveCompatibilityPolicy(c, nil))
	}
	for _, m := range models {
		if m.Compatibility != nil {
			policy = mergeCompatibilityPolicies(policy, m.Compatibility.Clone())
		}
		if m.Policy != nil {
			policy = mergeCompatibilityPolicies(policy, m.Policy.Clone())
		}
	}
	merged.Streaming = streaming
	merged.Reasoning = reasoning
	merged.ToolCalls = toolCalls
	merged.Images = images
	merged.ExplicitCache = explicit
	merged.PromptCacheKey = promptKey
	merged.Search = search
	merged.MediaGeneration = dedupeStrings(media)
	merged.Compatibility = policy
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

const maxProviderRetryDelay = 24 * time.Hour

// ClassifyResponseEvidence is the shared factual classifier used by active
// built-in and custom adapters. Adapter-specific classifiers may refine the
// result, but must preserve the bounded evidence contract.
func ClassifyResponseEvidence(evidence ResponseEvidence) ClassifiedResponse {
	return classifyByStatus(evidence)
}

func classifyByStatus(evidence ResponseEvidence) ClassifiedResponse {
	statusCode := evidence.StatusCode
	signal := bodySignal(evidence.BodyPrefix)
	retryAfter := parseResponseRetryAfter(evidence.Headers, time.Now())
	result := func(category ResponseCategory, code, message string, retryable, alternate bool, scope domaincontracts.RateScope) ClassifiedResponse {
		return ClassifiedResponse{
			StatusCode: statusCode, Category: category, Code: code,
			Retryable: retryable, AlternateAccountEligible: alternate,
			RetryAfter: retryAfter, Phase: domaincontracts.RatePhaseProvider,
			Scope: scope, Message: message,
		}
	}

	if statusCode >= 200 && statusCode < 300 {
		return result(CategorySuccess, "provider.success", "", false, false, domaincontracts.RateScopeRoute)
	}
	if signal == "content_policy" {
		return result(CategoryContentPolicy, "provider.content_policy", "provider content policy refusal", false, false, domaincontracts.RateScopeRoute)
	}
	if signal == "entitlement" && (statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden) {
		return result(CategoryEntitlement, "provider.entitlement_denied", "provider entitlement denied", false, false, domaincontracts.RateScopeAccount)
	}

	switch {
	case statusCode == http.StatusUnauthorized:
		return result(CategoryAuth, "provider.authentication_failed", "provider authentication failed", true, true, domaincontracts.RateScopeAccount)
	case statusCode == http.StatusForbidden:
		if signal == "auth" {
			return result(CategoryAuth, "provider.authentication_failed", "provider authentication failed", true, true, domaincontracts.RateScopeAccount)
		}
		if signal == "quota" || signal == "daily_quota" {
			code := "provider.quota_exhausted"
			if signal == "daily_quota" {
				code = "provider.daily_quota_exhausted"
			}
			return result(CategoryQuota, code, "provider quota exhausted", true, true, domaincontracts.RateScopeAccount)
		}
		return result(CategoryEntitlement, "provider.entitlement_denied", "provider entitlement denied", false, false, domaincontracts.RateScopeAccount)
	case statusCode == http.StatusRequestTimeout || statusCode == http.StatusTooEarly:
		return result(CategoryTransient, "provider.transient", "transient provider failure", true, true, domaincontracts.RateScopeProvider)
	case statusCode == http.StatusTooManyRequests:
		if signal == "quota" || signal == "daily_quota" {
			code := "provider.quota_exhausted"
			if signal == "daily_quota" {
				code = "provider.daily_quota_exhausted"
			}
			return result(CategoryQuota, code, "provider quota exhausted", true, true, domaincontracts.RateScopeAccount)
		}
		return result(CategoryRateLimit, "provider.rate_limit", "provider rate limited", true, true, domaincontracts.RateScopeAccount)
	case statusCode == http.StatusPaymentRequired:
		return result(CategoryQuota, "provider.quota_exhausted", "provider quota exhausted", false, false, domaincontracts.RateScopeAccount)
	case signal == "capacity":
		return result(CategoryCapacity, "provider.capacity", "provider model capacity unavailable", true, true, domaincontracts.RateScopeModel)
	case signal == "empty_output":
		return result(CategoryEmptyOutput, "provider.empty_output", "provider returned empty output", true, true, domaincontracts.RateScopeModel)
	case statusCode >= 500:
		return result(CategoryServerError, "provider.server_error", "provider server error", true, true, domaincontracts.RateScopeProvider)
	case statusCode >= 400:
		return result(CategoryInvalidRequest, "provider.invalid_request", "provider rejected the request", false, false, domaincontracts.RateScopeRoute)
	default:
		return result(CategoryFatal, "provider.failed", "provider request failed", false, false, domaincontracts.RateScopeProvider)
	}
}

// bodySignal recognizes only bounded provider-owned category markers. It never
// returns body text and therefore cannot expose credentials or request content.
func bodySignal(body []byte) string {
	if len(body) > MaxResponseEvidenceBodyBytes {
		body = body[:MaxResponseEvidenceBodyBytes]
	}
	lower := strings.ToLower(string(body))
	switch {
	case containsAny(lower, "content_policy", "content policy", "safety_violation", "blocked content", "policy violation", "content_filter"):
		return "content_policy"
	case containsAny(lower, "entitlement", "access_required", "subscription_required", "not entitled"):
		return "entitlement"
	case containsAny(lower, "reauthentication_required", "invalid_grant", "invalid_api_key", "authentication_failed", "token_expired"):
		return "auth"
	case containsAny(lower, "daily quota", "daily_quota", "daily limit", "free_usage_exhausted", "free usage exhausted"):
		return "daily_quota"
	case containsAny(lower, "insufficient_quota", "quota_exceeded", "billing_quota", "billing_hard_limit", "usage_limit", "credit exhausted", "resource_exhausted", "spend limit"):
		return "quota"
	case containsAny(lower, "model capacity", "model_capacity", "capacity exhausted", "model_overloaded", "model_unavailable", "capacity_exceeded", "overloaded"):
		return "capacity"
	case containsAny(lower, "empty output", "empty_response", "no output", "response_empty", `"output":[]`, `"choices":[]`, `"content":[]`):
		return "empty_output"
	default:
		return ""
	}
}

func containsAny(value string, markers ...string) bool {
	for _, marker := range markers {
		if strings.Contains(value, marker) {
			return true
		}
	}
	return false
}

func parseResponseRetryAfter(headers SafeResponseHeaders, now time.Time) time.Duration {
	var earliest time.Duration
	consider := func(delay time.Duration) {
		if delay <= 0 {
			return
		}
		if delay > maxProviderRetryDelay {
			delay = maxProviderRetryDelay
		}
		if earliest == 0 || delay < earliest {
			earliest = delay
		}
	}
	consider(parseRetryAfterValue(headers.RetryAfter, now))
	for _, value := range []string{
		headers.RateLimitReset, headers.RateLimitResetRequests,
		headers.RateLimitResetTokens, headers.AnthropicRateLimitRequestsReset,
		headers.AnthropicRateLimitTokensReset,
	} {
		consider(parseResetValue(value, now))
	}
	return earliest
}

func parseRetryAfterValue(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds >= 0 {
		if seconds > int64(maxProviderRetryDelay/time.Second) {
			return maxProviderRetryDelay
		}
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil {
		return at.Sub(now)
	}
	return 0
}

func parseResetValue(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if delay, err := time.ParseDuration(value); err == nil {
		return delay
	}
	if at, err := http.ParseTime(value); err == nil {
		return at.Sub(now)
	}
	if at, err := time.Parse(time.RFC3339, value); err == nil {
		return at.Sub(now)
	}
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil || number < 0 {
		return 0
	}
	if number > 1_000_000_000_000 {
		return time.UnixMilli(number).Sub(now)
	}
	if number > 100_000_000 {
		return time.Unix(number, 0).Sub(now)
	}
	if number > int64(maxProviderRetryDelay/time.Second) {
		return maxProviderRetryDelay
	}
	return time.Duration(number) * time.Second
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
