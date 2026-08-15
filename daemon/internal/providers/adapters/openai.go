package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	providerpkg "github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy/control/cacheplan"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
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
		Compatibility:  openAIPromptCompatibilityPolicy(),
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
		Compatibility:  openAIPromptCompatibilityPolicy(),
	}
}

func openAIPromptCompatibilityPolicy() providerpkg.CompatibilityPolicy {
	return providerpkg.CompatibilityPolicy{Generation: 1, Cache: providerpkg.CachePolicy{Prompt: providerpkg.PromptCachePolicy{Supported: true, Key: true, ExplicitBreakpoint: true, MinPrefixBytes: 4096, MarkerLocations: []string{"system"}}}}
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

const (
	OpenAIErrorInvalidRequest        = "providers/openai.invalid_request"
	OpenAIErrorTranslation           = "providers/openai.translation_failed"
	OpenAIErrorCapabilityUnsupported = "providers/openai.capability_unsupported"
	OpenAIErrorProviderMismatch      = "providers/openai.provider_mismatch"
	OpenAIErrorProviderProtocol      = "providers/openai.provider_protocol"
	OpenAIErrorCancelled             = "providers/openai.cancelled"
)

// OpenAIAdapterError is the stable, provider-owned machine-readable error.
// Transform causes are bounded and contain field/code context only; request
// bodies and credentials are never included.
type OpenAIAdapterError struct {
	Code       string
	ProviderID string
	Field      string
	Message    string
	Err        error
}

func (e *OpenAIAdapterError) Error() string {
	if e == nil {
		return OpenAIErrorProviderProtocol
	}
	detail := e.Message
	if e.Field != "" {
		if detail == "" {
			detail = e.Field
		} else {
			detail = e.Field + ": " + detail
		}
	}
	if e.Err != nil {
		if detail == "" {
			detail = e.Err.Error()
		} else {
			detail += ": " + e.Err.Error()
		}
	}
	if detail == "" {
		return e.Code
	}
	return e.Code + ": " + detail
}

func (e *OpenAIAdapterError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *OpenAIAdapterError) Is(target error) bool {
	other, ok := target.(*OpenAIAdapterError)
	return ok && other != nil && e != nil && e.Code == other.Code
}

func openAIError(code, providerID, field, message string, cause error) error {
	return &OpenAIAdapterError{Code: code, ProviderID: providerID, Field: field, Message: message, Err: cause}
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
	return p.BuildRequestContext(context.Background(), envelope, credential)
}

// BuildRequestContext preserves cancellation through canonical decoding and
// encoding. Only the native openai provider projects Chat input onto the
// Responses wire surface; OpenAI-compatible custom adapters retain their
// declared payload behavior.
func (p *OpenAIAdapter) BuildRequestContext(ctx context.Context, envelope RequestEnvelope, credential string) (BuiltRequest, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return BuiltRequest{}, openAIError(OpenAIErrorCancelled, p.meta.ID, "context", "operation cancelled", err)
	}
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
		return BuiltRequest{}, openAIError(OpenAIErrorInvalidRequest, p.meta.ID, "body", "request body must be a JSON object", nil)
	}
	if p.meta.ID != "openai" {
		payload, err := decodeJSONObject(envelope.Body)
		if err != nil {
			return BuiltRequest{}, openAIError(OpenAIErrorInvalidRequest, p.meta.ID, "body", "request body must be a JSON object", err)
		}
		payload["model"] = upstream
		policy := providerpkg.EffectiveCompatibilityPolicy(caps, entry)
		if _, err := cacheplan.PlanFinalWire(&cacheplan.FinalWireRequest{
			Protocol: cacheplan.ProtocolOpenAI, Surface: string(target.Surface), ProviderID: p.meta.ID,
			ModelID: target.UpstreamModelID, TenantID: envelope.Headers.Get("X-Tenant-ID"),
			PolicyGeneration: policy.Generation, Payload: payload,
		}, policy); err != nil {
			return BuiltRequest{}, err
		}
		body, err := json.Marshal(payload)
		if err != nil {
			return BuiltRequest{}, fmt.Errorf("providers/openai: marshal payload: %w", err)
		}
		return BuiltRequest{Endpoint: ep, Body: body, Auth: auth, Stream: envelope.Stream}, nil
	}

	payload, err := openAICanonicalResponses(ctx, envelope.Body, envelope.Stream, upstream)
	if err != nil {
		return BuiltRequest{}, err
	}
	target.Surface = SurfaceOpenAIResponses
	policy := providerpkg.EffectiveCompatibilityPolicy(caps, entry)
	if _, err := cacheplan.PlanFinalWire(&cacheplan.FinalWireRequest{
		Protocol: cacheplan.ProtocolOpenAI, Surface: string(target.Surface), ProviderID: p.meta.ID,
		ModelID: target.UpstreamModelID, TenantID: envelope.Headers.Get("X-Tenant-ID"),
		PolicyGeneration: policy.Generation, Payload: payload,
	}, policy); err != nil {
		return BuiltRequest{}, err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return BuiltRequest{}, fmt.Errorf("providers/openai: marshal payload: %w", err)
	}
	return BuiltRequest{Endpoint: p.Endpoint(target), Body: body, Auth: auth, Stream: envelope.Stream}, nil
}

// openAICanonicalResponses decodes either native Chat Completions or native
// Responses input and projects both through the canonical Responses encoder.
// Native Responses extensions are retained by the exact-pointer sidecar
// rather than by recursively merging arbitrary JSON keys.
func openAICanonicalResponses(ctx context.Context, body []byte, stream bool, upstream string) (map[string]any, error) {
	root, err := decodeJSONObject(body)
	if err != nil {
		return nil, openAIError(OpenAIErrorInvalidRequest, "openai", "body", "request body must be a JSON object", err)
	}
	_, hasMessages := root["messages"]
	_, hasInput := root["input"]
	if hasMessages && hasInput {
		return nil, openAIError(OpenAIErrorTranslation, "openai", "body", "request cannot contain both messages and input", nil)
	}
	source := contracts.ProtocolOpenAIResponse
	decoder := transforms.NewOpenAIResponsesRequestDecoder()
	if hasMessages {
		source = contracts.ProtocolOpenAIChat
		decoder = nil
	}
	canonicalBody := body
	if _, hasModel := root["model"]; !hasModel {
		root["model"] = upstream
		canonicalBody, err = json.Marshal(root)
		if err != nil {
			return nil, openAIError(OpenAIErrorInvalidRequest, "openai", "body", "request body could not be prepared for canonical decoding", err)
		}
	}
	var request *transforms.NormalizedRequest
	var transformErr *transforms.TransformError
	if source == contracts.ProtocolOpenAIChat {
		request, transformErr = transforms.NewOpenAIChatRequestDecoder().Decode(ctx, canonicalBody, stream)
	} else {
		request, transformErr = decoder.Decode(ctx, canonicalBody, stream)
	}
	if transformErr != nil {
		return nil, openAITransformError(transformErr, "canonical decoding")
	}
	request.Model = upstream
	encoded, transformErr := transforms.NewOpenAIResponsesCodec().Encode(ctx, request)
	if transformErr != nil {
		return nil, openAITransformError(transformErr, "Responses encoding")
	}
	wire := encoded.Wire
	if source == contracts.ProtocolOpenAIChat {
		promoteChatSystemInstructions(wire)
	}
	wire["model"] = upstream
	wire["stream"] = stream
	if source == contracts.ProtocolOpenAIResponse {
		sidecar, sidecarErr := transforms.CaptureNativeSidecar(source, body, wire)
		if sidecarErr != nil {
			return nil, openAITransformError(sidecarErr, "native Responses preservation")
		}
		wire, sidecarErr = sidecar.ApplySameSurface(contracts.ProtocolOpenAIResponse, wire)
		if sidecarErr != nil {
			return nil, openAITransformError(sidecarErr, "native Responses preservation")
		}
		// These provider controls are valid Responses-root fields but are not
		// represented in the shared canonical request yet. Preserve them only
		// for same-surface native input; cross-surface Chat projection remains
		// strictly owned by the canonical codec.
		for _, key := range []string{"store", "service_tier"} {
			if value, ok := root[key]; ok {
				wire[key] = value
			}
		}
	}
	return wire, nil
}

func promoteChatSystemInstructions(wire map[string]any) {
	items, ok := wire["input"].([]map[string]any)
	if !ok {
		return
	}
	instructions := make([]string, 0, 1)
	retained := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if item["role"] == "system" {
			if text, ok := item["content"].(string); ok && text != "" {
				instructions = append(instructions, text)
				continue
			}
		}
		retained = append(retained, item)
	}
	if len(instructions) == 0 {
		return
	}
	wire["input"] = retained
	wire["instructions"] = strings.Join(instructions, "\n")
}

func openAITransformError(transformErr *transforms.TransformError, operation string) error {
	if transformErr == nil {
		return openAIError(OpenAIErrorProviderProtocol, "openai", "body", operation+" failed", nil)
	}
	code := OpenAIErrorInvalidRequest
	if transformErr.Code == transforms.CodeUnsupportedFeature {
		code = OpenAIErrorTranslation
	} else if transformErr.Code == transforms.CodeContextCanceled {
		code = OpenAIErrorCancelled
	}
	return openAIError(code, "openai", transformErr.Field, operation+" failed", transformErr)
}

// ClassifyResponse implements Provider.
func (p *OpenAIAdapter) ClassifyResponse(evidence ResponseEvidence) ClassifiedResponse {
	return classifyByStatus(evidence)
}
