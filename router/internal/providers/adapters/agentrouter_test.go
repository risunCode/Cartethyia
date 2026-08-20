package adapters

import (
	"net/http"
	"testing"
)

func TestAgentRouterAdapterContract(t *testing.T) {
	p := NewAgentRouterAdapter()
	if got := p.Metadata().ID; got != "agentrouter" {
		t.Fatalf("Metadata ID = %q", got)
	}
	if !HasCapability(p.Capabilities(), SurfaceAnthropicMessages) {
		t.Fatal("AgentRouter should support Anthropic messages")
	}
	models := p.Models()
	target, err := p.ResolveTarget("claude-opus-4-8", SurfaceAnthropicMessages)
	if err != nil {
		t.Fatal(err)
	}
	if target.ProviderID != "agentrouter" || target.ModelID != "claude-opus-4-8" {
		t.Fatalf("unexpected target: %#v", target)
	}
	if _, err := p.ResolveTarget("missing", SurfaceAnthropicMessages); err == nil {
		t.Fatal("missing model unexpectedly resolved")
	}
	if _, err := p.ResolveTarget("claude-opus-4-8", SurfaceOpenAIChat); err == nil {
		t.Fatal("unsupported surface unexpectedly resolved")
	}
	if models.Get("claude-opus-4-8") == nil {
		t.Fatal("published model missing")
	}
	endpoint := p.Endpoint(target)
	if endpoint.Method != http.MethodPost || endpoint.Path != "v1/messages" || endpoint.Query["beta"] != "true" {
		t.Fatalf("unexpected endpoint: %#v", endpoint)
	}
}

func TestAgentRouterAuthAndBuildRequest(t *testing.T) {
	p := NewAgentRouterAdapter()
	target, err := p.ResolveTarget("claude-opus-4-8", SurfaceAnthropicMessages)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.AuthMaterial("", target); err == nil {
		t.Fatal("empty credential unexpectedly accepted")
	}
	if _, err := p.AuthMaterial("key", RouteTarget{ProviderID: "other", Surface: SurfaceAnthropicMessages}); err == nil {
		t.Fatal("mismatched provider unexpectedly accepted")
	}
	if _, err := p.AuthMaterial("key", RouteTarget{ProviderID: p.meta.ID, Surface: SurfaceOpenAIChat}); err == nil {
		t.Fatal("mismatched surface unexpectedly accepted")
	}
	auth, err := p.AuthMaterial("secret", target)
	if err != nil {
		t.Fatal(err)
	}
	if auth.Headers.Get("x-api-key") != "secret" || auth.Headers.Get("anthropic-version") == "" || auth.Headers.Get("x-claude-code-session-id") == "" {
		t.Fatalf("incomplete auth headers: %#v", auth.Headers)
	}
	body := []byte(`{"model":"claude-opus-4-8"}`)
	req, err := p.BuildRequest(RequestEnvelope{Target: target, Body: body, Stream: true}, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if string(req.Body) != string(body) || !req.Stream || req.Auth.Headers.Get("x-api-key") != "secret" {
		t.Fatalf("unexpected built request: %#v", req)
	}
	if got := p.ClassifyResponse(NewResponseEvidence(http.StatusOK, nil, nil)); got.Category == "" {
		t.Fatal("classification category was empty")
	}
}
