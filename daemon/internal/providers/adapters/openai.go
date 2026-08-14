package adapters

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// openAISurfaces is the set of wire surfaces the native OpenAI adapter
// serves. It mirrors the OPENAI_SURFACES / OPENAI_TEXT_SURFACES split in
// src.old/providers/openai.ts.
var openAISurfaces = []Surface{SurfaceOpenAIResponses, SurfaceImages}

// openAITextSurfaces is the subset of surfaces that participate in
// aggregate capability projection. Image generation has different defaults.
var openAITextSurfaces = []Surface{SurfaceOpenAIChat, SurfaceOpenAIResponses}

func cloneHeaders(source http.Header) http.Header {
	if len(source) == 0 {
		return nil
	}
	return source.Clone()
}

// openAIDefaultCaps is the fallback capability record for models that
// don't carry their own ProviderCaps override.
func openAIDefaultCaps() ProviderCaps {
	return ProviderCaps{
		Surfaces:       append([]Surface(nil), openAISurfaces...),
		Streaming:      true,
		ToolCalls:      true,
		ExplicitCache:  true,
		PromptCacheKey: true,
	}
}

// openAITextCaps builds the default capability record for a text model.
// The reasoning/images overrides are lifted from the legacy
// openAiTextCapabilities() helper.
func openAITextCaps(reasoning, images bool) ProviderCaps {
	return ProviderCaps{
		Surfaces:       append([]Surface(nil), openAITextSurfaces...),
		Streaming:      true,
		Reasoning:      reasoning,
		ToolCalls:      true,
		Images:         images,
		ExplicitCache:  true,
		PromptCacheKey: true,
	}
}

// openAIDefaultModels mirrors OPENAI_DEFAULT_MODELS in src.old/providers/openai.ts.
func openAIDefaultModels() []ProviderModel {
	cap := func(reasoning, images bool) *ProviderCaps { c := openAITextCaps(reasoning, images); return &c }
	imageCaps := func() *ProviderCaps {
		c := ProviderCaps{Surfaces: []Surface{SurfaceImages}, Streaming: false, Images: true}
		return &c
	}
	return []ProviderModel{
		Model("gpt-5.6", "GPT-5.6", cap(true, true)),
		Model("gpt-5.6-sol-pro", "GPT-5.6 Sol Pro", cap(true, true)),
		Model("gpt-5.6-sol", "GPT-5.6 Sol", cap(true, true)),
		Model("gpt-5.6-terra-pro", "GPT-5.6 Terra Pro", cap(true, true)),
		Model("gpt-5.6-terra", "GPT-5.6 Terra", cap(true, true)),
		Model("gpt-5.6-luna-pro", "GPT-5.6 Luna Pro", cap(true, true)),
		Model("gpt-5.6-luna", "GPT-5.6 Luna", cap(true, true)),
		Model("gpt-5.5", "GPT-5.5", cap(true, true)),
		Model("gpt-5.5-pro", "GPT-5.5 Pro", cap(true, true)),
		Model("gpt-5.4", "GPT-5.4", cap(true, true)),
		Model("gpt-5.4-mini", "GPT-5.4 Mini", cap(true, true)),
		Model("gpt-5.4-pro", "GPT-5.4 Pro", cap(true, true)),
		Model("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", cap(true, true)),
		Model("gpt-5", "GPT-5", cap(true, true)),
		Model("gpt-5-mini", "GPT-5 Mini", cap(true, false)),
		Model("gpt-5-nano", "GPT-5 Nano", cap(true, false)),
		Model("gpt-4.1", "GPT-4.1", cap(false, true)),
		Model("gpt-4.1-mini", "GPT-4.1 Mini", cap(false, true)),
		Model("gpt-4.1-nano", "GPT-4.1 Nano", cap(false, false)),
		Model("gpt-4o", "GPT-4o", cap(false, true)),
		Model("gpt-4o-mini", "GPT-4o Mini", cap(false, true)),
		Model("o3", "O3", cap(true, false)),
		Model("o4-mini", "O4 Mini", cap(true, false)),
		Model("dall-e-3", "DALL-E 3", imageCaps()),
		Model("gpt-image-1", "GPT Image 1", imageCaps()),
	}
}

// OpenAIAdapterConfig configures the OpenAI Provider. BaseURL and
// CredentialRef are provider-owned settings; no environment lookup belongs
// in the runtime.
type OpenAIAdapterConfig struct {
	ID             string
	DisplayName    string
	BaseURL        string
	CredentialRef  string
	CredentialKind CredentialKind
	CredentialURL  string
	Headers        http.Header
	Surfaces       []Surface
	Models         []ProviderModel
}

// OpenAIAdapter is the native OpenAI provider: Responses API and hosted
// image generation. The provider does not perform network I/O; it builds
// the wire-format request and classifies the response.
type OpenAIAdapter struct {
	meta    ProviderMeta
	caps    ProviderCaps
	catalog *staticCatalog
	baseURL string
	headers http.Header
}

// NewOpenAIAdapter returns an OpenAI Provider built from cfg.
func NewOpenAIAdapter(cfg OpenAIAdapterConfig) *OpenAIAdapter {
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	id := cfg.ID
	if id == "" {
		id = "openai"
	}
	display := cfg.DisplayName
	if display == "" {
		display = "OpenAI"
	}
	ck := cfg.CredentialKind
	if ck == "" {
		ck = CredentialAPIKey
	}
	ref := cfg.CredentialRef
	if ref == "" {
		ref = providerCredentialRef(id)
	}
	models := cfg.Models
	if models == nil && id == "openai" {
		models = openAIDefaultModels()
	}
	surfaces := append([]Surface(nil), cfg.Surfaces...)
	if len(surfaces) == 0 {
		surfaces = append([]Surface(nil), openAISurfaces...)
	}
	fallback := openAIDefaultCaps()
	fallback.Surfaces = surfaces
	caps := aggregateCapabilities(models, fallback)
	return &OpenAIAdapter{
		meta: ProviderMeta{
			ID:              id,
			DisplayName:     display,
			Protocol:        ProtocolOpenAI,
			CredentialKind:  ck,
			CredentialKinds: []CredentialKind{ck},
			CredentialRef:   ref,
			BaseURL:         base,
			CredentialURL:   cfg.CredentialURL,
		},
		caps:    caps,
		catalog: newStaticCatalog(models),
		baseURL: base,
		headers: cloneHeaders(cfg.Headers),
	}
}

// Metadata implements Provider.
func (p *OpenAIAdapter) Metadata() ProviderMeta { return p.meta }

// Capabilities implements Provider.
func (p *OpenAIAdapter) Capabilities() ProviderCaps { return p.caps }

// Models implements Provider.
func (p *OpenAIAdapter) Models() ProviderModelCatalog { return p.catalog }

func (p *OpenAIAdapter) ResolveTarget(modelID string, surface Surface) (RouteTarget, error) {
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
	return RouteTarget{
		ProviderID:      p.meta.ID,
		ModelID:         entry.ID,
		UpstreamModelID: upstream,
		Surface:         surface,
	}, nil
}

func (p *OpenAIAdapter) modelCapabilities(entry *ProviderModel) ProviderCaps {
	caps := p.caps
	if entry != nil && entry.Capabilities != nil {
		caps = *entry.Capabilities
	}
	if entry != nil && len(entry.Surfaces) > 0 {
		caps.Surfaces = append([]Surface(nil), entry.Surfaces...)
	}
	return caps
}

// Endpoint implements Provider. Native OpenAI text and image traffic use the
// Responses endpoint; OpenAI-compatible custom adapters retain their declared
// chat endpoint behavior.
func (p *OpenAIAdapter) Endpoint(target RouteTarget) Endpoint {
	if target.Surface == SurfaceImages || target.Surface == SurfaceOpenAIResponses || p.meta.ID == "openai" {
		return Endpoint{Method: http.MethodPost, Path: "responses"}
	}
	return Endpoint{Method: http.MethodPost, Path: "chat/completions"}
}

// AuthMaterial implements Provider.
func (p *OpenAIAdapter) AuthMaterial(credential string, target RouteTarget) (AuthMaterial, error) {
	if target.ProviderID != "" && target.ProviderID != p.meta.ID {
		return AuthMaterial{}, &IDMismatchError{AdapterID: p.meta.ID, TargetID: target.ProviderID}
	}
	if credential == "" {
		if p.meta.CredentialKind == CredentialNone {
			credential = "public"
		} else {
			return AuthMaterial{}, &AuthError{ProviderID: p.meta.ID, Reason: "missing API key"}
		}
	}
	headers := http.Header{}
	for key, values := range p.headers {
		for _, value := range values {
			headers.Add(key, strings.ReplaceAll(value, "{{credential}}", credential))
		}
	}
	if headers.Get("Authorization") == "" && headers.Get("X-API-Key") == "" && headers.Get("Api-Key") == "" {
		headers.Set("Authorization", "Bearer "+credential)
	}
	headers.Set("Content-Type", "application/json")
	return AuthMaterial{Headers: headers}, nil
}

// BuildRequest implements Provider. It preserves the selected OpenAI wire
// surface, then applies automatic prompt-cache routing and (for GPT-5.6+
// models) an explicit stable-prefix breakpoint when the prefix is large
// enough for the upstream requirement.
func (p *OpenAIAdapter) BuildRequest(envelope RequestEnvelope, credential string) (BuiltRequest, error) {
	auth, err := p.AuthMaterial(credential, envelope.Target)
	if err != nil {
		return BuiltRequest{}, err
	}
	if envelope.Target.ProviderID != "" && envelope.Target.ProviderID != p.meta.ID {
		return BuiltRequest{}, &IDMismatchError{AdapterID: p.meta.ID, TargetID: envelope.Target.ProviderID}
	}
	entry := p.catalog.Get(envelope.Target.ModelID)
	if entry == nil {
		return BuiltRequest{}, &UnknownModelError{ProviderID: p.meta.ID, ModelID: envelope.Target.ModelID}
	}
	caps := p.modelCapabilities(entry)
	if !containsSurface(caps.Surfaces, envelope.Target.Surface) {
		return BuiltRequest{}, &UnknownSurfaceError{ProviderID: p.meta.ID, Surface: envelope.Target.Surface}
	}
	upstream := envelope.Target.UpstreamModelID
	if upstream == "" {
		upstream = entry.UpstreamID
		if upstream == "" {
			upstream = entry.ID
		}
	}
	target := envelope.Target
	target.UpstreamModelID = upstream
	ep := p.Endpoint(target)
	if target.Surface == SurfaceImages {
		body, err := json.Marshal(map[string]any{
			"model":  upstream,
			"stream": envelope.Stream,
			"prompt": json.RawMessage(envelope.Body),
		})
		if err != nil {
			return BuiltRequest{}, fmt.Errorf("providers/openai: marshal image payload: %w", err)
		}
		return BuiltRequest{Endpoint: ep, Body: body, Auth: auth, Stream: envelope.Stream}, nil
	}
	if len(bytes.TrimSpace(envelope.Body)) == 0 {
		return BuiltRequest{}, errors.New("providers/openai: request body must be a JSON object")
	}
	payload := map[string]any{}
	if err := json.Unmarshal(envelope.Body, &payload); err != nil || payload == nil {
		if err == nil {
			err = errors.New("body must be a JSON object")
		}
		return BuiltRequest{}, fmt.Errorf("providers/openai: request body must be a JSON object: %w", err)
	}
	payload["model"] = upstream
	if p.meta.ID == "openai" && target.Surface != SurfaceImages {
		translateChatMessagesToResponses(payload)
		target.Surface = SurfaceOpenAIResponses
	}
	applyOpenAIPromptCache(payload, target, p.meta.ID, caps)
	body, err := json.Marshal(payload)
	if err != nil {
		return BuiltRequest{}, fmt.Errorf("providers/openai: marshal payload: %w", err)
	}
	return BuiltRequest{Endpoint: ep, Body: body, Auth: auth, Stream: envelope.Stream}, nil
}

func translateChatMessagesToResponses(payload map[string]any) {
	if _, exists := payload["input"]; exists {
		delete(payload, "messages")
		return
	}
	messages, ok := payload["messages"].([]any)
	if !ok {
		return
	}
	input := make([]any, 0, len(messages))
	for _, raw := range messages {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		content := message["content"]
		if role == "system" {
			payload["instructions"] = content
			continue
		}
		input = append(input, map[string]any{"role": role, "content": content})
	}
	delete(payload, "messages")
	payload["input"] = input
}

const minimumExplicitCachePrefixBytes = 4096

func applyOpenAIPromptCache(payload map[string]any, target RouteTarget, providerID string, caps ProviderCaps) {
	if payload == nil || (!caps.PromptCacheKey && !caps.ExplicitCache) {
		return
	}
	stable := openAIStablePrefix(payload, target.Surface)
	sum := sha256.Sum256(stable)
	if caps.PromptCacheKey {
		if raw, ok := payload["prompt_cache_key"].(string); !ok || strings.TrimSpace(raw) == "" {
			payload["prompt_cache_key"] = "cartethyia:" + providerID + ":" + target.UpstreamModelID + ":" + hex.EncodeToString(sum[:8])
		}
	}
	if !caps.ExplicitCache || len(stable) < minimumExplicitCachePrefixBytes || !supportsOpenAIPromptBreakpoints(target.UpstreamModelID) {
		return
	}
	if target.Surface == SurfaceOpenAIResponses {
		if markResponsesStablePrefix(payload) {
			payload["prompt_cache_options"] = map[string]any{"mode": "explicit"}
		}
		return
	}
	if target.Surface == SurfaceOpenAIChat {
		if markChatStablePrefix(payload) {
			payload["prompt_cache_options"] = map[string]any{"mode": "explicit"}
		}
	}
}

func supportsOpenAIPromptBreakpoints(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	if !strings.Contains(model, "gpt-5.6") {
		return false
	}
	return true
}

func openAIStablePrefix(payload map[string]any, surface Surface) []byte {
	stable := map[string]any{}
	if tools, ok := payload["tools"]; ok {
		stable["tools"] = tools
	}
	if surface == SurfaceOpenAIResponses {
		if instructions, ok := payload["instructions"]; ok {
			stable["instructions"] = instructions
		}
		if input, ok := payload["input"].([]any); ok {
			prefix := make([]any, 0, len(input))
			for _, item := range input {
				record, ok := item.(map[string]any)
				if !ok {
					break
				}
				role, _ := record["role"].(string)
				if role != "system" && role != "developer" {
					break
				}
				prefix = append(prefix, record)
			}
			if len(prefix) > 0 {
				stable["input"] = prefix
			}
		}
	} else if messages, ok := payload["messages"].([]any); ok {
		prefix := make([]any, 0, len(messages))
		for _, item := range messages {
			record, ok := item.(map[string]any)
			if !ok {
				break
			}
			role, _ := record["role"].(string)
			if role != "system" && role != "developer" {
				break
			}
			prefix = append(prefix, record)
		}
		if len(prefix) > 0 {
			stable["messages"] = prefix
		}
	}
	encoded, _ := json.Marshal(stable)
	return encoded
}

func markChatStablePrefix(payload map[string]any) bool {
	messages, ok := payload["messages"].([]any)
	if !ok {
		return false
	}
	last := -1
	for i, raw := range messages {
		record, ok := raw.(map[string]any)
		if !ok {
			break
		}
		role, _ := record["role"].(string)
		if role != "system" && role != "developer" {
			break
		}
		last = i
	}
	if last < 0 {
		return false
	}
	record, ok := messages[last].(map[string]any)
	if !ok {
		return false
	}
	return markOpenAIContent(record, "text")
}

func markResponsesStablePrefix(payload map[string]any) bool {
	input, ok := payload["input"].([]any)
	if !ok {
		return false
	}
	last := -1
	for i, raw := range input {
		record, ok := raw.(map[string]any)
		if !ok {
			break
		}
		role, _ := record["role"].(string)
		if role != "system" && role != "developer" {
			break
		}
		last = i
	}
	if last < 0 {
		return false
	}
	record, ok := input[last].(map[string]any)
	if !ok {
		return false
	}
	return markOpenAIContent(record, "input_text")
}

func markOpenAIContent(record map[string]any, blockType string) bool {
	switch content := record["content"].(type) {
	case string:
		record["content"] = []any{map[string]any{
			"type":                    contentTypeForCache(blockType),
			"text":                    content,
			"prompt_cache_breakpoint": map[string]any{"mode": "explicit"},
		}}
		return content != ""
	case []any:
		for i := len(content) - 1; i >= 0; i-- {
			block, ok := content[i].(map[string]any)
			if !ok {
				continue
			}
			kind, _ := block["type"].(string)
			if kind != blockType {
				continue
			}
			block["prompt_cache_breakpoint"] = map[string]any{"mode": "explicit"}
			return true
		}
	}
	return false
}

func contentTypeForCache(blockType string) string {
	if blockType == "input_text" {
		return "input_text"
	}
	return "text"
}

// ClassifyResponse implements Provider.
func (p *OpenAIAdapter) ClassifyResponse(statusCode int, body []byte) ClassifiedResponse {
	return classifyByStatus(statusCode, body)
}
