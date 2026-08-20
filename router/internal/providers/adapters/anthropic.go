package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	providerpkg "github.com/cartethyia/daemon/internal/providers"
	transforms "github.com/cartethyia/daemon/internal/protocol/codec"
)

// anthropicSurfaces is the wire surface the native Anthropic adapter serves.
var anthropicSurfaces = []Surface{SurfaceAnthropicMessages}

const (
	AnthropicErrorInvalidRequest        = "providers/anthropic.invalid_request"
	AnthropicErrorCapabilityUnsupported = "providers/anthropic.capability_unsupported"
	AnthropicErrorProviderMismatch      = "providers/anthropic.provider_mismatch"
	AnthropicErrorProviderProtocol      = "providers/anthropic.provider_protocol"
	AnthropicErrorProviderFailure       = "providers/anthropic.provider_failure"
	AnthropicErrorCancelled             = "providers/anthropic.cancelled"
)

// AnthropicAdapterError is the stable, provider-owned machine-readable error.
// Its fields never contain credentials or unbounded upstream bodies.
type AnthropicAdapterError struct {
	Code       string
	ProviderID string
	Field      string
	Message    string
	Err        error
}

func (e *AnthropicAdapterError) Error() string {
	if e == nil {
		return AnthropicErrorProviderProtocol
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

func (e *AnthropicAdapterError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *AnthropicAdapterError) Is(target error) bool {
	other, ok := target.(*AnthropicAdapterError)
	return ok && other != nil && e != nil && e.Code == other.Code
}

func anthropicError(code, providerID, field, message string, cause error) error {
	return &AnthropicAdapterError{Code: code, ProviderID: providerID, Field: field, Message: message, Err: cause}
}

func anthropicCancelled(ctx context.Context, providerID string) error {
	if err := ctx.Err(); err != nil {
		return anthropicError(AnthropicErrorCancelled, providerID, "", "operation cancelled", err)
	}
	return nil
}

// anthropicDefaultModels mirrors ANTHROPIC_DEFAULT_MODELS in
// src.old/providers/anthropic.ts.
func anthropicDefaultModels() []ProviderModel {
	cap := func() *ProviderCaps {
		c := anthropicDefaultCaps()
		return &c
	}
	return []ProviderModel{
		Model("claude-opus-5", "Claude Opus 5", cap()),
		Model("claude-sonnet-5", "Claude Sonnet 5", cap()),
		Model("claude-fable-5", "Claude Fable 5", cap()),
		Model("claude-opus-4-8", "Claude Opus 4.8", cap()),
		Model("claude-opus-4-7", "Claude Opus 4.7", cap()),
		Model("claude-opus-4-6", "Claude Opus 4.6", cap()),
		Model("claude-sonnet-4-6", "Claude Sonnet 4.6", cap()),
		Model("claude-haiku-4-5", "Claude Haiku 4.5", cap()),
		Model("claude-opus-4-1", "Claude Opus 4.1", cap()),
		Model("claude-sonnet-4-5", "Claude Sonnet 4.5", cap()),
		Model("claude-haiku-4-5", "Claude Haiku 4.5", cap()),
		Model("claude-3-7-sonnet", "Claude 3.7 Sonnet", cap()),
		Model("claude-3-5-haiku-latest", "Claude 3.5 Haiku", cap()),
	}
}

// anthropicDefaultCaps mirrors ANTHROPIC_FALLBACK_CAPABILITIES. The legacy
// helper also turns on streaming implicitly; we surface it explicitly here.
func anthropicDefaultCaps() ProviderCaps {
	return ProviderCaps{
		Surfaces:       append([]Surface(nil), anthropicSurfaces...),
		Streaming:      true,
		Reasoning:      true,
		ToolCalls:      true,
		Images:         true,
		Search:         true,
		ExplicitCache:  true,
		PromptCacheKey: true,
		Compatibility:  providerpkg.CompatibilityPolicy{Generation: 1, Cache: providerpkg.CachePolicy{Prompt: providerpkg.PromptCachePolicy{Supported: true, Key: true, ExplicitBreakpoint: true, MinPrefixBytes: 1, MarkerLocations: []string{"system", "tools", "message"}, TTLs: []time.Duration{5 * time.Minute, time.Hour}}}},
	}
}

// AnthropicAdapterConfig configures the native Anthropic adapter. Provider
// identity owns the endpoint and credential reference; runtime env lookup is
// intentionally not part of this contract.
type AnthropicAdapterConfig struct {
	ID             string
	DisplayName    string
	BaseURL        string
	CredentialRef  string
	CredentialKind CredentialKind
	Auth           string
	Headers        http.Header
	Models         []ProviderModel
}

// AnthropicAdapter is the native Anthropic provider speaking the Messages
// wire format. The legacy adapter also wired a beta header for prompt
// caching; this adapter exposes the same behaviour via AuthMaterial.
type AnthropicAdapter struct {
	meta    ProviderMeta
	caps    ProviderCaps
	catalog *staticCatalog
	baseURL string
	auth    string
	headers http.Header
}

// NewAnthropicAdapter returns an Anthropic Provider built from cfg.
func NewAnthropicAdapter(cfg AnthropicAdapterConfig) *AnthropicAdapter {
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = "https://api.anthropic.com/v1"
	}
	id := cfg.ID
	if id == "" {
		id = "anthropic"
	}
	display := cfg.DisplayName
	if display == "" {
		display = "Anthropic"
	}
	ck := cfg.CredentialKind
	if ck == "" {
		ck = CredentialAPIKey
	}
	ref := cfg.CredentialRef
	if ref == "" {
		ref = providerCredentialRef(id)
	}
	auth := cfg.Auth
	if auth == "" {
		auth = "x-api-key"
	}
	models := cfg.Models
	if models == nil {
		models = anthropicDefaultModels()
	}
	caps := aggregateCapabilities(models, anthropicDefaultCaps())
	return &AnthropicAdapter{
		meta: ProviderMeta{
			ID:              id,
			DisplayName:     display,
			Protocol:        ProtocolAnthropic,
			CredentialKind:  ck,
			CredentialKinds: []CredentialKind{ck},
			CredentialRef:   ref,
			BaseURL:         base,
		},
		caps:    caps,
		catalog: newStaticCatalog(models),
		baseURL: base,
		auth:    auth,
		headers: cloneHeaders(cfg.Headers),
	}
}

// Metadata implements Provider.
func (p *AnthropicAdapter) Metadata() ProviderMeta { return p.meta }

// Capabilities implements Provider.
func (p *AnthropicAdapter) Capabilities() ProviderCaps { return p.caps }

// Models implements Provider.
func (p *AnthropicAdapter) Models() ProviderModelCatalog { return p.catalog }

// ResolveTarget implements Provider.
func (p *AnthropicAdapter) ResolveTarget(modelID string, surface Surface) (RouteTarget, error) {
	if surface != SurfaceAnthropicMessages || !HasCapability(p.caps, surface) {
		return RouteTarget{}, &UnknownSurfaceError{ProviderID: p.meta.ID, Surface: surface}
	}
	entry := p.catalog.Get(modelID)
	if entry == nil {
		return RouteTarget{}, &UnknownModelError{ProviderID: p.meta.ID, ModelID: modelID}
	}
	caps := p.modelCapabilities(entry)
	if !containsSurface(caps.Surfaces, surface) {
		return RouteTarget{}, anthropicError(AnthropicErrorCapabilityUnsupported, p.meta.ID, "surface", "model does not support Anthropic Messages", nil)
	}
	upstream := entry.UpstreamID
	if upstream == "" {
		upstream = entry.ID
	}
	return RouteTarget{ProviderID: p.meta.ID, ModelID: entry.ID, UpstreamModelID: upstream, Surface: surface}, nil
}

func containsSurface(surfaces []Surface, surface Surface) bool {
	for _, candidate := range surfaces {
		if candidate == surface {
			return true
		}
	}
	return false
}

func (p *AnthropicAdapter) modelCapabilities(entry *ProviderModel) ProviderCaps {
	caps := p.caps
	if entry != nil && entry.Capabilities != nil {
		caps = *entry.Capabilities
	}
	if entry != nil && len(entry.Surfaces) > 0 {
		caps.Surfaces = append([]Surface(nil), entry.Surfaces...)
	}
	return caps
}

// Endpoint implements Provider.
func (p *AnthropicAdapter) Endpoint(target RouteTarget) Endpoint {
	return Endpoint{Method: http.MethodPost, Path: "messages"}
}

// AuthMaterial implements Provider. The legacy adapter added the
// prompt-caching beta header conditionally; we mirror that here.
func (p *AnthropicAdapter) AuthMaterial(credential string, target RouteTarget) (AuthMaterial, error) {
	if target.ProviderID != "" && target.ProviderID != p.meta.ID {
		return AuthMaterial{}, anthropicError(AnthropicErrorProviderMismatch, p.meta.ID, "target.provider_id", "adapter cannot serve this provider", &IDMismatchError{AdapterID: p.meta.ID, TargetID: target.ProviderID})
	}
	if credential == "" {
		return AuthMaterial{}, &AuthError{ProviderID: p.meta.ID, Reason: "missing API key"}
	}
	if p.auth != "x-api-key" && p.auth != "bearer" && p.auth != "custom" {
		return AuthMaterial{}, anthropicError(AnthropicErrorInvalidRequest, p.meta.ID, "auth", "unsupported authentication mode", nil)
	}
	headers := http.Header{}
	for key, values := range p.headers {
		for _, value := range values {
			headers.Add(key, strings.ReplaceAll(value, "{{credential}}", credential))
		}
	}
	if headers.Get("Content-Type") == "" {
		headers.Set("content-type", "application/json")
	}
	headers.Set("anthropic-version", "2023-06-01")
	if p.caps.ExplicitCache && p.caps.PromptCacheKey {
		headers.Set("anthropic-beta", "prompt-caching-2024-07-31")
	}
	if p.meta.ID == "claude" {
		headers.Set("anthropic-version", claudeOAuthVersion)
		headers.Set("anthropic-beta", strings.Join(claudeOAuthBetas, ","))
		headers.Set("anthropic-dangerous-direct-browser-access", "true")
		headers.Set("x-app", "cli")
		headers.Set("x-client-request-id", randomUUID())
		headers.Set("anthropic-client-version", claudeClientVersion)
		headers.Set("user-agent", fmt.Sprintf("claude-cli/%s (external, local-agent, agent-sdk/%s)", claudeCodeVersion, claudeAgentSDKVersion))
	}
	if p.auth == "custom" {
		if headers.Get("Authorization") == "" && headers.Get("X-API-Key") == "" && headers.Get("Api-Key") == "" {
			return AuthMaterial{}, &AuthError{ProviderID: p.meta.ID, Reason: "custom authentication requires an auth header"}
		}
	} else if p.auth == "bearer" {
		headers.Set("Authorization", "Bearer "+credential)
	} else {
		headers.Set("x-api-key", credential)
	}
	return AuthMaterial{Headers: headers}, nil
}

func (p *AnthropicAdapter) BuildRequest(envelope RequestEnvelope, credential string) (BuiltRequest, error) {
	return p.BuildRequestContext(context.Background(), envelope, credential)
}

// BuildRequestContext preserves cancellation through canonical decoding and
// encoding.
func (p *AnthropicAdapter) BuildRequestContext(ctx context.Context, envelope RequestEnvelope, credential string) (BuiltRequest, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := anthropicCancelled(ctx, p.meta.ID); err != nil {
		return BuiltRequest{}, err
	}
	target, entry, err := p.validateTarget(envelope.Target)
	if err != nil {
		return BuiltRequest{}, err
	}
	body, err := anthropicRequestBody(envelope.Body, target.UpstreamModelID, p.meta.ID)
	if err != nil {
		return BuiltRequest{}, err
	}
	decoder := transforms.NewAnthropicMessagesRequestDecoder()
	request, transformErr := decoder.Decode(ctx, body, envelope.Stream)
	if transformErr != nil {
		return BuiltRequest{}, anthropicError(AnthropicErrorInvalidRequest, p.meta.ID, "body", "request failed canonical decoding", transformErr)
	}
	if err := p.validateRequestCapabilities(request, p.modelCapabilities(entry)); err != nil {
		return BuiltRequest{}, err
	}
	encoder := transforms.NewAnthropicMessagesCodec()
	encoded, transformErr := encoder.Encode(ctx, request)
	if transformErr != nil {
		return BuiltRequest{}, anthropicError(AnthropicErrorInvalidRequest, p.meta.ID, "body", "request failed Anthropic encoding", transformErr)
	}
	wire := encoded.Wire
	wire["model"] = target.UpstreamModelID
	wire["stream"] = envelope.Stream
	if p.meta.ID == "claude" {
		applyClaudeCodePolicy(wire, envelope)
	}
	caps := p.modelCapabilities(entry)
	policy := providerpkg.EffectiveCompatibilityPolicy(caps, entry)
	_ = policy // cache planning removed — providers work without explicit cache keys
	wireBody, err := json.Marshal(wire)
	if err != nil {
		return BuiltRequest{}, anthropicError(AnthropicErrorInvalidRequest, p.meta.ID, "body", "request could not be encoded", err)
	}
	auth, err := p.AuthMaterial(credential, target)
	if err != nil {
		return BuiltRequest{}, err
	}
	auth.Headers.Set("accept", "application/json")
	if envelope.Stream {
		auth.Headers.Set("accept", "text/event-stream")
	}
	if p.meta.ID == "claude" {
		wireBody = attestClaudePayload(wireBody)
	}
	return BuiltRequest{Endpoint: p.Endpoint(target), Body: wireBody, Auth: auth, Stream: envelope.Stream}, nil
}

func (p *AnthropicAdapter) validateTarget(target RouteTarget) (RouteTarget, *ProviderModel, error) {
	if target.ProviderID != "" && target.ProviderID != p.meta.ID {
		return RouteTarget{}, nil, anthropicError(AnthropicErrorProviderMismatch, p.meta.ID, "target.provider_id", "adapter cannot serve this provider", &IDMismatchError{AdapterID: p.meta.ID, TargetID: target.ProviderID})
	}
	if target.Surface != SurfaceAnthropicMessages {
		return RouteTarget{}, nil, &UnknownSurfaceError{ProviderID: p.meta.ID, Surface: target.Surface}
	}
	entry := p.catalog.Get(target.ModelID)
	if entry == nil {
		return RouteTarget{}, nil, &UnknownModelError{ProviderID: p.meta.ID, ModelID: target.ModelID}
	}
	caps := p.modelCapabilities(entry)
	if !containsSurface(caps.Surfaces, target.Surface) {
		return RouteTarget{}, nil, anthropicError(AnthropicErrorCapabilityUnsupported, p.meta.ID, "surface", "model does not support Anthropic Messages", nil)
	}
	target.ProviderID = p.meta.ID
	target.ModelID = entry.ID
	target.UpstreamModelID = entry.UpstreamID
	if target.UpstreamModelID == "" {
		target.UpstreamModelID = entry.ID
	}
	return target, entry, nil
}

func (p *AnthropicAdapter) validateRequestCapabilities(request *transforms.NormalizedRequest, caps ProviderCaps) error {
	if request == nil {
		return anthropicError(AnthropicErrorInvalidRequest, p.meta.ID, "request", "canonical request is nil", nil)
	}
	if request.Stream && !caps.Streaming {
		return anthropicError(AnthropicErrorCapabilityUnsupported, p.meta.ID, "stream", "model does not support streaming", nil)
	}
	if len(request.Tools) > 0 && !caps.ToolCalls {
		return anthropicError(AnthropicErrorCapabilityUnsupported, p.meta.ID, "tools", "model does not support tools", nil)
	}
	if len(request.Images) > 0 && !caps.Images {
		return anthropicError(AnthropicErrorCapabilityUnsupported, p.meta.ID, "images", "model does not support images", nil)
	}
	if request.Reasoning == transforms.ReasoningEnabled && !caps.Reasoning {
		return anthropicError(AnthropicErrorCapabilityUnsupported, p.meta.ID, "thinking", "model does not support reasoning", nil)
	}
	if request.ResponseFormat != "" && request.ResponseFormat != transforms.FormatText {
		return anthropicError(AnthropicErrorCapabilityUnsupported, p.meta.ID, "response_format", "structured response formats are not supported by this adapter", nil)
	}
	if len(request.MCPServers) > 0 && !caps.Search {
		return anthropicError(AnthropicErrorCapabilityUnsupported, p.meta.ID, "mcp_servers", "model does not support server tools", nil)
	}
	for i, tool := range request.Tools {
		if tool.NativeType != "" && !caps.Search {
			return anthropicError(AnthropicErrorCapabilityUnsupported, p.meta.ID, fmt.Sprintf("tools[%d]", i), "model does not support server tools", nil)
		}
	}
	return nil
}

func anthropicRequestBody(body []byte, model, providerID string) ([]byte, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, anthropicError(AnthropicErrorInvalidRequest, providerID, "body", "request body is empty", nil)
	}
	var root map[string]any
	if err := json.Unmarshal(trimmed, &root); err != nil {
		return nil, anthropicError(AnthropicErrorInvalidRequest, providerID, "body", "body is not a JSON object", err)
	}
	if root == nil {
		return nil, anthropicError(AnthropicErrorInvalidRequest, providerID, "body", "body must be a JSON object", nil)
	}
	if raw, ok := root["model"]; ok {
		if raw == nil {
			return nil, anthropicError(AnthropicErrorInvalidRequest, providerID, "model", "model must be a string", nil)
		}
		if value, ok := raw.(string); !ok || strings.TrimSpace(value) == "" {
			return nil, anthropicError(AnthropicErrorInvalidRequest, providerID, "model", "model must be a non-empty string", nil)
		}
	}
	root["model"] = model
	encoded, err := json.Marshal(root)
	if err != nil {
		return nil, anthropicError(AnthropicErrorInvalidRequest, providerID, "body", "body could not be normalized", err)
	}
	return encoded, nil
}

// ClassifyResponse implements Provider.
func (p *AnthropicAdapter) ClassifyResponse(evidence ResponseEvidence) ClassifiedResponse {
	return classifyByStatus(evidence)
}

// DecodeResponse maps an Anthropic Messages response into canonical events,
// preserving text, reasoning, tool calls, native server blocks, stop reason,
// and prompt-cache usage evidence.
func (p *AnthropicAdapter) DecodeResponse(ctx context.Context, body []byte, model string) (*transforms.NormalizedResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := anthropicCancelled(ctx, p.meta.ID); err != nil {
		return nil, err
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil || root == nil {
		return nil, anthropicError(AnthropicErrorProviderProtocol, p.meta.ID, "body", "response body must be a JSON object", err)
	}
	wireModel, _ := root["model"].(string)
	if wireModel == "" {
		wireModel = model
	}
	if wireModel == "" {
		return nil, anthropicError(AnthropicErrorProviderProtocol, p.meta.ID, "model", "response model is missing", nil)
	}
	rawContent, ok := root["content"].([]any)
	if !ok {
		return nil, anthropicError(AnthropicErrorProviderProtocol, p.meta.ID, "content", "response content must be an array", nil)
	}
	response := &transforms.NormalizedResponse{Model: wireModel}
	response.Events = append(response.Events, transforms.NormalizedEvent{Type: "message_start", Raw: root})
	for i, raw := range rawContent {
		block, ok := raw.(map[string]any)
		if !ok {
			return nil, anthropicError(AnthropicErrorProviderProtocol, p.meta.ID, fmt.Sprintf("content[%d]", i), "content block must be an object", nil)
		}
		kind, _ := block["type"].(string)
		switch kind {
		case "text":
			text, ok := block["text"].(string)
			if !ok {
				return nil, anthropicError(AnthropicErrorProviderProtocol, p.meta.ID, fmt.Sprintf("content[%d].text", i), "text is missing", nil)
			}
			response.Events = append(response.Events, transforms.NormalizedEvent{Type: "text_delta", Text: text, Raw: block})
		case "thinking":
			text, ok := block["thinking"].(string)
			if !ok {
				return nil, anthropicError(AnthropicErrorProviderProtocol, p.meta.ID, fmt.Sprintf("content[%d].thinking", i), "thinking is missing", nil)
			}
			response.Events = append(response.Events, transforms.NormalizedEvent{Type: "thinking_delta", ReasoningText: text, Raw: block})
		case "tool_use":
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			if id == "" || name == "" {
				return nil, anthropicError(AnthropicErrorProviderProtocol, p.meta.ID, fmt.Sprintf("content[%d]", i), "tool_use requires id and name", nil)
			}
			args, err := json.Marshal(block["input"])
			if err != nil {
				return nil, anthropicError(AnthropicErrorProviderProtocol, p.meta.ID, fmt.Sprintf("content[%d].input", i), "tool input is not encodable", err)
			}
			response.Events = append(response.Events,
				transforms.NormalizedEvent{Type: "tool_call_start", ToolCallID: id, ToolName: name, Raw: block},
				transforms.NormalizedEvent{Type: "tool_call_delta", ToolCallID: id, ToolArguments: string(args)},
				transforms.NormalizedEvent{Type: "tool_call_end", ToolCallID: id})
		default:
			if kind == "" {
				return nil, anthropicError(AnthropicErrorProviderProtocol, p.meta.ID, fmt.Sprintf("content[%d].type", i), "content type is missing", nil)
			}
			response.Events = append(response.Events, transforms.NormalizedEvent{Type: "server_tool_result", Raw: block})
		}
	}
	if usage, ok := root["usage"].(map[string]any); ok {
		parsed, err := parseAnthropicUsage(usage, p.meta.ID)
		if err != nil {
			return nil, err
		}
		response.Usage = &parsed
		response.Events = append(response.Events, transforms.NormalizedEvent{Type: "usage", Usage: &parsed})
	}
	stop := anthropicStopReason(valueString(root["stop_reason"]))
	response.StopReason = stop
	response.Events = append(response.Events, transforms.NormalizedEvent{Type: "message_stop", StopReason: &stop})
	for _, event := range response.Events {
		if event.Type == "text_delta" {
			response.Text += event.Text
		}
		if event.Type == "tool_call_start" {
			response.ToolCalls = append(response.ToolCalls, transforms.NormalizedToolCall{ID: event.ToolCallID, Name: event.ToolName})
		}
		if event.Type == "tool_call_delta" && len(response.ToolCalls) > 0 {
			for i := range response.ToolCalls {
				if response.ToolCalls[i].ID == event.ToolCallID {
					response.ToolCalls[i].Arguments += event.ToolArguments
				}
			}
		}
	}
	return response, nil
}

func valueString(value any) string {
	text, _ := value.(string)
	return text
}

func anthropicStopReason(value string) transforms.StopReason {
	switch value {
	case "max_tokens":
		return transforms.StopLength
	case "tool_use":
		return transforms.StopToolCall
	case "refusal":
		return transforms.StopContentFilter
	default:
		return transforms.StopCompleted
	}
}

func parseAnthropicUsage(raw map[string]any, providerID string) (transforms.Usage, error) {
	read := func(field string) (int, error) {
		value := raw[field]
		if value == nil {
			return 0, nil
		}
		number, ok := value.(float64)
		if !ok || number < 0 || number != float64(int(number)) {
			return 0, anthropicError(AnthropicErrorProviderProtocol, providerID, "usage."+field, "usage value must be a non-negative integer", nil)
		}
		return int(number), nil
	}
	input, err := read("input_tokens")
	if err != nil {
		return transforms.Usage{}, err
	}
	output, err := read("output_tokens")
	if err != nil {
		return transforms.Usage{}, err
	}
	cacheRead, err := read("cache_read_input_tokens")
	if err != nil {
		return transforms.Usage{}, err
	}
	cacheWrite, err := read("cache_creation_input_tokens")
	if err != nil {
		return transforms.Usage{}, err
	}
	total, err := read("total_tokens")
	if err != nil {
		return transforms.Usage{}, err
	}
	if total == 0 {
		total = input + output
	}
	return transforms.Usage{InputTokens: input, OutputTokens: output, TotalTokens: total, CacheRead: cacheRead, CacheWrite: cacheWrite}, nil
}

// AnthropicStreamDecoder incrementally maps one SSE event into canonical
// events. Tool ids are retained between content_block_start and deltas.
type AnthropicStreamDecoder struct {
	providerID string
	toolIDs    map[int]string
}

func (p *AnthropicAdapter) NewStreamDecoder() *AnthropicStreamDecoder {
	return &AnthropicStreamDecoder{providerID: p.meta.ID, toolIDs: make(map[int]string)}
}

func (d *AnthropicStreamDecoder) Decode(ctx context.Context, frame []byte) ([]transforms.NormalizedEvent, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := anthropicCancelled(ctx, d.providerID); err != nil {
		return nil, err
	}
	data := bytes.TrimSpace(frame)
	if !bytes.HasPrefix(data, []byte("{")) {
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "data:") {
				data = []byte(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
				break
			}
		}
	}
	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil || root == nil {
		return nil, anthropicError(AnthropicErrorProviderProtocol, d.providerID, "event", "stream event must be JSON", err)
	}
	kind, _ := root["type"].(string)
	switch kind {
	case "message_start":
		return []transforms.NormalizedEvent{{Type: "message_start", Raw: root}}, nil
	case "content_block_start":
		index := intValue(root["index"])
		block, _ := root["content_block"].(map[string]any)
		if block == nil {
			return nil, anthropicError(AnthropicErrorProviderProtocol, d.providerID, "content_block", "content block is missing", nil)
		}
		if typ, _ := block["type"].(string); typ == "tool_use" {
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			if id == "" || name == "" {
				return nil, anthropicError(AnthropicErrorProviderProtocol, d.providerID, "content_block", "tool_use requires id and name", nil)
			}
			d.toolIDs[index] = id
			return []transforms.NormalizedEvent{{Type: "tool_call_start", ToolCallID: id, ToolName: name, Raw: block}}, nil
		}
		return []transforms.NormalizedEvent{{Type: "native_block_start", Raw: block}}, nil
	case "content_block_delta":
		index := intValue(root["index"])
		delta, _ := root["delta"].(map[string]any)
		if delta == nil {
			return nil, anthropicError(AnthropicErrorProviderProtocol, d.providerID, "delta", "delta is missing", nil)
		}
		typ, _ := delta["type"].(string)
		switch typ {
		case "text_delta":
			return []transforms.NormalizedEvent{{Type: "text_delta", Text: valueString(delta["text"]), Raw: root}}, nil
		case "thinking_delta":
			return []transforms.NormalizedEvent{{Type: "thinking_delta", ReasoningText: valueString(delta["thinking"]), Raw: root}}, nil
		case "input_json_delta":
			id := d.toolIDs[index]
			if id == "" {
				return nil, anthropicError(AnthropicErrorProviderProtocol, d.providerID, "delta", "tool id is missing", nil)
			}
			return []transforms.NormalizedEvent{{Type: "tool_call_delta", ToolCallID: id, ToolArguments: valueString(delta["partial_json"]), Raw: root}}, nil
		default:
			return []transforms.NormalizedEvent{{Type: "native_block_delta", Raw: root}}, nil
		}
	case "content_block_stop":
		index := intValue(root["index"])
		id := d.toolIDs[index]
		if id != "" {
			delete(d.toolIDs, index)
			return []transforms.NormalizedEvent{{Type: "tool_call_end", ToolCallID: id, Raw: root}}, nil
		}
		return []transforms.NormalizedEvent{{Type: "native_block_stop", Raw: root}}, nil
	case "message_delta":
		event := transforms.NormalizedEvent{Type: "message_delta", Raw: root}
		if delta, ok := root["delta"].(map[string]any); ok {
			stop := anthropicStopReason(valueString(delta["stop_reason"]))
			event.StopReason = &stop
		}
		if usage, ok := root["usage"].(map[string]any); ok {
			parsed, err := parseAnthropicUsage(usage, d.providerID)
			if err != nil {
				return nil, err
			}
			event.Usage = &parsed
		}
		return []transforms.NormalizedEvent{event}, nil
	case "message_stop":
		return []transforms.NormalizedEvent{{Type: "message_stop", Raw: root}}, nil
	case "error":
		return nil, anthropicError(AnthropicErrorProviderFailure, d.providerID, "event", "Anthropic stream failed", nil)
	default:
		return []transforms.NormalizedEvent{{Type: "native_event", Raw: root}}, nil
	}
}

func intValue(value any) int {
	number, _ := value.(float64)
	if number < 0 {
		return 0
	}
	return int(number)
}
