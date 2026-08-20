package adapters

import "net/http"

// agentRouterSurfaces is the single surface the AgentRouter adapter serves.
var agentRouterSurfaces = []Surface{SurfaceAnthropicMessages}

// agentRouterModel is the lone model the AgentRouter adapter publishes.
func agentRouterModel() ProviderModel {
	caps := ProviderCaps{
		Surfaces:  append([]Surface(nil), agentRouterSurfaces...),
		Streaming: true,
		Reasoning: true,
		Images:    true,
	}
	return Model("claude-opus-4-8", "Claude Opus 4.8", &caps)
}

// AgentRouterAdapter speaks native Anthropic Messages behind a client-
// identity gate. Its provider-specific endpoint, identity headers, and
// classification remain in the adapter; account selection, retries, and
// credential lifecycle stay in their respective runtime owners.
type AgentRouterAdapter struct {
	meta    ProviderMeta
	caps    ProviderCaps
	catalog *staticCatalog
}

// AgentRouterAdapterConfig carries provider-owned identity and catalog data.
// It deliberately contains no account-selection or retry settings.
type AgentRouterAdapterConfig struct {
	ID             string
	DisplayName    string
	BaseURL        string
	CredentialRef  string
	CredentialKind CredentialKind
	Models         []ProviderModel
}

// NewAgentRouterAdapter returns the AgentRouter provider.
func NewAgentRouterAdapter(configs ...AgentRouterAdapterConfig) *AgentRouterAdapter {
	var cfg AgentRouterAdapterConfig
	if len(configs) > 0 {
		cfg = configs[0]
	}
	if cfg.ID == "" {
		cfg.ID = "agentrouter"
	}
	if cfg.DisplayName == "" {
		cfg.DisplayName = "AgentRouter"
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://agentrouter.org"
	}
	if cfg.CredentialKind == "" {
		cfg.CredentialKind = CredentialAPIKey
	}
	if cfg.CredentialRef == "" {
		cfg.CredentialRef = providerCredentialRef(cfg.ID)
	}
	models := append([]ProviderModel(nil), cfg.Models...)
	if len(models) == 0 {
		models = []ProviderModel{agentRouterModel()}
	}
	caps := aggregateCapabilities(models, ProviderCaps{
		Surfaces:  append([]Surface(nil), agentRouterSurfaces...),
		Streaming: true,
		Reasoning: true,
		Images:    true,
	})
	return &AgentRouterAdapter{
		meta: ProviderMeta{
			ID:              cfg.ID,
			DisplayName:     cfg.DisplayName,
			Protocol:        ProtocolAnthropic,
			CredentialKind:  cfg.CredentialKind,
			CredentialKinds: []CredentialKind{cfg.CredentialKind},
			CredentialRef:   cfg.CredentialRef,
			BaseURL:         cfg.BaseURL,
		},
		caps:    caps,
		catalog: newStaticCatalog(models),
	}
}

func (p *AgentRouterAdapter) Metadata() ProviderMeta       { return p.meta }
func (p *AgentRouterAdapter) Capabilities() ProviderCaps   { return p.caps }
func (p *AgentRouterAdapter) Models() ProviderModelCatalog { return p.catalog }

func (p *AgentRouterAdapter) ResolveTarget(modelID string, surface Surface) (RouteTarget, error) {
	if surface != SurfaceAnthropicMessages {
		return RouteTarget{}, &UnknownSurfaceError{ProviderID: p.meta.ID, Surface: surface}
	}
	entry := p.catalog.Get(modelID)
	if entry == nil {
		return RouteTarget{}, &UnknownModelError{ProviderID: p.meta.ID, ModelID: modelID}
	}
	return RouteTarget{
		ProviderID:      p.meta.ID,
		ModelID:         entry.ID,
		UpstreamModelID: entry.UpstreamID,
		Surface:         surface,
	}, nil
}

func (p *AgentRouterAdapter) Endpoint(target RouteTarget) Endpoint {
	return Endpoint{
		Method: http.MethodPost,
		Path:   "v1/messages",
		Query:  map[string]string{"beta": "true"},
	}
}

func (p *AgentRouterAdapter) AuthMaterial(credential string, target RouteTarget) (AuthMaterial, error) {
	if target.ProviderID != "" && target.ProviderID != p.meta.ID {
		return AuthMaterial{}, &IDMismatchError{AdapterID: p.meta.ID, TargetID: target.ProviderID}
	}
	if target.Surface != SurfaceAnthropicMessages {
		return AuthMaterial{}, &UnknownSurfaceError{ProviderID: p.meta.ID, Surface: target.Surface}
	}
	if credential == "" {
		return AuthMaterial{}, &AuthError{ProviderID: p.meta.ID, Reason: "AgentRouter requires an API key"}
	}
	headers := http.Header{}
	headers.Set("content-type", "application/json")
	headers.Set("anthropic-version", "2023-06-01")
	headers.Set("anthropic-beta", "claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24")
	headers.Set("anthropic-dangerous-direct-browser-access", "true")
	headers.Set("x-app", "cli")
	headers.Set("user-agent", "claude-cli/2.1.195 (external, sdk-cli)")
	headers.Set("x-claude-code-session-id", randomUUID())
	headers.Set("x-stainless-retry-count", "0")
	headers.Set("x-stainless-timeout", "600")
	headers.Set("x-stainless-lang", "js")
	headers.Set("x-stainless-package-version", "0.94.0")
	headers.Set("x-stainless-os", "MacOS")
	headers.Set("x-stainless-arch", "arm64")
	headers.Set("x-stainless-runtime", "node")
	headers.Set("x-stainless-runtime-version", "v24.3.0")
	headers.Set("accept-encoding", "gzip, deflate, br, zstd")
	headers.Set("x-api-key", credential)
	return AuthMaterial{Headers: headers}, nil
}

func (p *AgentRouterAdapter) BuildRequest(envelope RequestEnvelope, credential string) (BuiltRequest, error) {
	auth, err := p.AuthMaterial(credential, envelope.Target)
	if err != nil {
		return BuiltRequest{}, err
	}
	return BuiltRequest{
		Endpoint: p.Endpoint(envelope.Target),
		Body:     envelope.Body,
		Auth:     auth,
		Stream:   envelope.Stream,
	}, nil
}

func (p *AgentRouterAdapter) ClassifyResponse(evidence ResponseEvidence) ClassifiedResponse {
	return classifyByStatus(evidence)
}
