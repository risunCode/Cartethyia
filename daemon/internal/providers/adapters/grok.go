package adapters

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// GrokBuildConfig configures the OAuth-backed Grok Build Responses adapter.
// Grok is kept separate from OpenAI-compatible Chat Completions providers even
// though both use bearer authentication and an OpenAI-family protocol name.
type GrokBuildConfig struct {
	ID             string
	DisplayName    string
	BaseURL        string
	CredentialRef  string
	CredentialKind CredentialKind
	Models         []ProviderModel
}

// GrokBuildAdapter owns Grok Responses request normalization, required request
// identity headers, prompt-cache identity, and Grok-specific classification.
type GrokBuildAdapter struct {
	meta    ProviderMeta
	caps    ProviderCaps
	catalog *staticCatalog
	baseURL string
}

// NewGrokBuildAdapter constructs the canonical grok-build provider.
func NewGrokBuildAdapter(cfg GrokBuildConfig) *GrokBuildAdapter {
	id := cfg.ID
	if id == "" {
		id = "grok-build"
	}
	display := cfg.DisplayName
	if display == "" {
		display = "Grok Build"
	}
	credentialKind := cfg.CredentialKind
	if credentialKind == "" {
		credentialKind = CredentialOAuth
	}
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if baseURL == "" {
		baseURL = "https://cli-chat-proxy.grok.com/v1"
	}
	credentialRef := cfg.CredentialRef
	if strings.TrimSpace(credentialRef) == "" {
		credentialRef = providerCredentialRef(id)
	}
	models := cfg.Models
	caps := aggregateCapabilities(models, ProviderCaps{
		Surfaces: []Surface{SurfaceOpenAIResponses}, Streaming: true, Reasoning: true,
		ToolCalls: true, PromptCacheKey: true,
	})
	return &GrokBuildAdapter{
		meta: ProviderMeta{
			ID: id, DisplayName: display, Protocol: ProtocolOpenAI,
			CredentialKind: credentialKind, CredentialKinds: []CredentialKind{credentialKind},
			CredentialRef: credentialRef, BaseURL: baseURL,
		},
		caps: caps, catalog: newStaticCatalog(models), baseURL: baseURL,
	}
}

func (p *GrokBuildAdapter) Metadata() ProviderMeta       { return p.meta }
func (p *GrokBuildAdapter) Capabilities() ProviderCaps   { return p.caps }
func (p *GrokBuildAdapter) Models() ProviderModelCatalog { return p.catalog }

func (p *GrokBuildAdapter) ResolveTarget(modelID string, surface Surface) (RouteTarget, error) {
	entry := p.catalog.Get(modelID)
	if entry == nil {
		return RouteTarget{}, &UnknownModelError{ProviderID: p.meta.ID, ModelID: modelID}
	}
	caps := p.modelCapabilities(entry)
	if !containsSurface(caps.Surfaces, surface) {
		return RouteTarget{}, &UnknownSurfaceError{ProviderID: p.meta.ID, Surface: surface}
	}
	upstream := entry.UpstreamID
	if upstream == "" {
		upstream = entry.ID
	}
	return RouteTarget{ProviderID: p.meta.ID, ModelID: entry.ID, UpstreamModelID: upstream, Surface: surface}, nil
}

func (p *GrokBuildAdapter) modelCapabilities(entry *ProviderModel) ProviderCaps {
	caps := p.caps
	if entry != nil && entry.Capabilities != nil {
		caps = *entry.Capabilities
	}
	if entry != nil && len(entry.Surfaces) > 0 {
		caps.Surfaces = append([]Surface(nil), entry.Surfaces...)
	}
	return caps
}

func (p *GrokBuildAdapter) Endpoint(target RouteTarget) Endpoint {
	if target.Surface != SurfaceOpenAIResponses {
		return Endpoint{Method: http.MethodPost, Path: "chat/completions"}
	}
	return Endpoint{Method: http.MethodPost, Path: "responses"}
}

// AuthMaterial implements Provider with Grok's required request identity.
func (p *GrokBuildAdapter) AuthMaterial(credential string, target RouteTarget) (AuthMaterial, error) {
	if target.ProviderID != "" && target.ProviderID != p.meta.ID {
		return AuthMaterial{}, &IDMismatchError{AdapterID: p.meta.ID, TargetID: target.ProviderID}
	}
	if credential == "" {
		return AuthMaterial{}, &AuthError{ProviderID: p.meta.ID, Reason: "missing OAuth access token"}
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+credential)
	headers.Set("Content-Type", "application/json")
	auth := AuthMaterial{Headers: headers}
	auth.Headers.Set("User-Agent", "grok-build")
	auth.Headers.Set("x-grok-client-identifier", "grok-build")
	auth.Headers.Set("x-grok-token-auth", "grok-build")
	auth.Headers.Set("x-grok-session-id", randomUUID())
	auth.Headers.Set("x-grok-request-id", randomUUID())
	if target.Surface == SurfaceOpenAIResponses {
		auth.Headers.Set("Accept", "text/event-stream")
	}
	return auth, nil
}

// BuildRequest implements Provider for the Grok Responses surface only.
func (p *GrokBuildAdapter) BuildRequest(envelope RequestEnvelope, credential string) (BuiltRequest, error) {
	if envelope.Target.Surface != SurfaceOpenAIResponses {
		return BuiltRequest{}, &UnknownSurfaceError{ProviderID: p.meta.ID, Surface: envelope.Target.Surface}
	}
	auth, payload, target, err := p.requestParts(envelope, credential)
	if err != nil {
		return BuiltRequest{}, err
	}
	if err := validateGrokResponsesPayload(payload); err != nil {
		return BuiltRequest{}, err
	}
	applyGrokPromptCacheIdentity(payload, envelope.Headers, target.UpstreamModelID)
	normalizeGrokResponsesPayload(payload, envelope.Stream, target.UpstreamModelID)
	if envelope.Stream {
		auth.Headers.Set("Accept", "text/event-stream")
	} else {
		auth.Headers.Set("Accept", "application/json")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return BuiltRequest{}, fmt.Errorf("providers/grok-build: marshal payload: %w", err)
	}
	return BuiltRequest{
		Endpoint: p.Endpoint(target),
		Body:     body,
		Auth:     auth,
		Stream:   envelope.Stream,
	}, nil
}

func (p *GrokBuildAdapter) requestParts(envelope RequestEnvelope, credential string) (AuthMaterial, map[string]any, RouteTarget, error) {
	target, err := p.ResolveTarget(envelope.Target.ModelID, envelope.Target.Surface)
	if err != nil {
		return AuthMaterial{}, nil, RouteTarget{}, err
	}
	if envelope.Target.ProviderID != "" && envelope.Target.ProviderID != p.meta.ID {
		return AuthMaterial{}, nil, RouteTarget{}, &IDMismatchError{AdapterID: p.meta.ID, TargetID: envelope.Target.ProviderID}
	}
	if len(bytesTrim(envelope.Body)) == 0 {
		return AuthMaterial{}, nil, RouteTarget{}, errors.New("providers/grok-build: request body is empty")
	}
	payload, err := decodeJSONObject(envelope.Body)
	if err != nil {
		return AuthMaterial{}, nil, RouteTarget{}, fmt.Errorf("providers/grok-build: request body must be a JSON object: %w", err)
	}
	auth, err := p.AuthMaterial(credential, target)
	if err != nil {
		return AuthMaterial{}, nil, RouteTarget{}, err
	}
	return auth, payload, target, nil
}

func validateGrokResponsesPayload(payload map[string]any) error {
	if raw, exists := payload["messages"]; exists {
		if _, hasInput := payload["input"]; !hasInput {
			return errors.New("providers/grok-build: chat messages require an explicit canonical Responses conversion")
		}
		if _, ok := raw.([]any); !ok {
			return errors.New("providers/grok-build: messages must be an array")
		}
		return errors.New("providers/grok-build: mixed messages and input are ambiguous")
	}
	if input, exists := payload["input"]; exists {
		items, ok := input.([]any)
		if !ok || len(items) == 0 {
			return errors.New("providers/grok-build: input must be a non-empty array")
		}
		for index, raw := range items {
			item, ok := raw.(map[string]any)
			if !ok {
				return fmt.Errorf("providers/grok-build: input[%d] must be an object", index)
			}
			kind, _ := item["type"].(string)
			if strings.TrimSpace(kind) == "" {
				return fmt.Errorf("providers/grok-build: input[%d].type is required", index)
			}
			if kind == "message" {
				role, _ := item["role"].(string)
				if role == "" {
					return fmt.Errorf("providers/grok-build: input[%d].role is required", index)
				}
				if _, ok := item["content"]; !ok {
					return fmt.Errorf("providers/grok-build: input[%d].content is required", index)
				}
			}
		}
	}
	if tools, exists := payload["tools"]; exists {
		items, ok := tools.([]any)
		if !ok {
			return errors.New("providers/grok-build: tools must be an array")
		}
		for index, raw := range items {
			tool, ok := raw.(map[string]any)
			if !ok {
				return fmt.Errorf("providers/grok-build: tools[%d] must be an object", index)
			}
			kind, _ := tool["type"].(string)
			if kind != "function" && kind != "custom" && kind != "namespace" {
				return fmt.Errorf("providers/grok-build: tools[%d].type is unsupported", index)
			}
			if kind == "function" {
				fn, ok := tool["function"].(map[string]any)
				if !ok {
					return fmt.Errorf("providers/grok-build: tools[%d].function is required", index)
				}
				name, _ := fn["name"].(string)
				if strings.TrimSpace(name) == "" {
					return fmt.Errorf("providers/grok-build: tools[%d].function.name is required", index)
				}
			}
		}
	}
	if reasoningContent, ok := payload["reasoning_content"]; ok {
		if _, valid := reasoningContent.(string); !valid {
			return errors.New("providers/grok-build: reasoning_content must be a string")
		}
	}
	return nil
}

func applyGrokPromptCacheIdentity(payload map[string]any, headers http.Header, upstream string) {
	if payload == nil {
		return
	}
	tenant := "anonymous"
	if headers != nil {
		for _, key := range []string{"X-Cartethyia-Tenant", "X-Tenant-ID", "X-Organization-ID"} {
			if value := strings.TrimSpace(headers.Get(key)); value != "" {
				tenant = value
				break
			}
		}
	}
	stable := map[string]any{
		"tenant": tenant,
		"model":  upstream,
		"input":  payload["input"],
		"tools":  payload["tools"],
	}
	encoded, err := json.Marshal(stable)
	if err != nil {
		return
	}
	sum := sha256.Sum256(encoded)
	payload["prompt_cache_key"] = "cartethyia:grok:" + hex.EncodeToString(sum[:16])
}

const grokCompactPrompt = "Summarize the conversation so far faithfully and concisely. Preserve the user's request, decisions, technical details, file paths, commands, and unresolved work so another assistant can continue."

func normalizeGrokResponsesPayload(payload map[string]any, stream bool, upstream string) {
	payload["model"] = upstream
	payload["store"] = false
	payload["stream"] = stream
	if compact, ok := payload["compact"].(bool); ok && compact {
		if input, ok := payload["input"].([]any); ok {
			payload["input"] = append(input, map[string]any{
				"type": "message", "role": "user",
				"content": []any{map[string]any{"type": "input_text", "text": grokCompactPrompt}},
			})
		}
		payload["tool_choice"] = "none"
		payload["stream"] = false
		payload["include"] = []any{"reasoning.encrypted_content"}
		delete(payload, "compact")
	}
	if reasoningContent, ok := payload["reasoning_content"].(string); ok && strings.TrimSpace(reasoningContent) != "" {
		if input, ok := payload["input"].([]any); ok {
			payload["input"] = append([]any{map[string]any{
				"type":    "reasoning",
				"summary": []any{map[string]any{"type": "summary_text", "text": reasoningContent}},
			}}, input...)
		}
		delete(payload, "reasoning_content")
	}
	for _, key := range []string{
		"messages", "max_tokens", "max_completion_tokens", "n", "seed",
		"logprobs", "top_logprobs", "frequency_penalty", "presence_penalty",
		"user", "stream_options", "previous_response_id",
	} {
		delete(payload, key)
	}
	if effort, ok := payload["reasoning_effort"].(string); ok && strings.TrimSpace(effort) != "" {
		payload["reasoning"] = map[string]any{"effort": strings.ToLower(strings.TrimSpace(effort)), "summary": "concise"}
		delete(payload, "reasoning_effort")
	} else if reasoning, ok := payload["reasoning"].(map[string]any); ok {
		if _, exists := reasoning["summary"]; !exists {
			reasoning["summary"] = "concise"
		}
	} else {
		payload["reasoning"] = map[string]any{"effort": "high", "summary": "concise"}
	}
	reasoning, _ := payload["reasoning"].(map[string]any)
	effort, _ := reasoning["effort"].(string)
	if strings.ToLower(strings.TrimSpace(effort)) != "none" {
		include, _ := payload["include"].([]any)
		found := false
		for _, value := range include {
			if value == "reasoning.encrypted_content" {
				found = true
				break
			}
		}
		if !found {
			payload["include"] = append(include, "reasoning.encrypted_content")
		}
	}
}

// ClassifyResponse starts with the shared classifier and only adds Grok
// categories that the unified status/body contract cannot infer safely.
func (p *GrokBuildAdapter) ClassifyResponse(statusCode int, body []byte) ClassifiedResponse {
	classified := classifyByStatus(statusCode, body)
	const maxScan = 16 * 1024
	raw := body
	if len(raw) > maxScan {
		raw = raw[:maxScan]
	}
	lower := strings.ToLower(string(raw))
	if classified.Category == CategoryContentPolicy {
		return classified
	}
	switch {
	case strings.Contains(lower, "entitlement"), strings.Contains(lower, "access denied"), strings.Contains(lower, "access_required"):
		classified.Category = CategoryEntitlement
		classified.Retryable = false
		classified.Message = "Grok entitlement denied"
	case strings.Contains(lower, "empty output"), strings.Contains(lower, "empty_response"), strings.Contains(lower, "no output"), strings.Contains(lower, "response_empty"), strings.Contains(lower, `"output":[]`), strings.Contains(lower, `"choices":[]`), strings.Contains(lower, `"content":[]`):
		classified.Category = CategoryEmptyOutput
		classified.Retryable = true
		classified.Message = "Grok returned empty output"
	case strings.Contains(lower, "model capacity"), strings.Contains(lower, "model_capacity"), strings.Contains(lower, "capacity exhausted"), strings.Contains(lower, "model_overloaded"), strings.Contains(lower, "model_unavailable"), strings.Contains(lower, "capacity_exceeded"):
		classified.Category = CategoryCapacity
		classified.Retryable = true
		classified.Message = "Grok model capacity unavailable"
	case strings.Contains(lower, "free usage"), strings.Contains(lower, "free_usage"), strings.Contains(lower, "insufficient balance"), strings.Contains(lower, "spend limit"), strings.Contains(lower, "billing"), strings.Contains(lower, "credit exhausted"), strings.Contains(lower, "resource_exhausted"):
		classified.Category = CategoryQuota
		classified.Retryable = true
		classified.Message = "Grok quota exhausted"
	case statusCode == http.StatusPaymentRequired:
		classified.Category = CategoryQuota
		classified.Retryable = true
		classified.Message = "Grok billing quota exhausted"
	case statusCode >= 500:
		classified.Category = CategoryServerError
		classified.Retryable = true
		classified.Message = "Grok upstream server error"
	}
	return classified
}
