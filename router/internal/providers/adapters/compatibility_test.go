package adapters

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestOpenAIResolveTargetHonorsModelSurfaceAndUpstream(t *testing.T) {
	caps := ProviderCaps{Surfaces: []Surface{SurfaceOpenAIResponses}, Streaming: true}
	adapter := NewOpenAIAdapter(OpenAIAdapterConfig{Models: []ProviderModel{
		ModelWithUpstream("client-model", "wire-model", "Client model", &caps),
	}})
	target, err := adapter.ResolveTarget("client-model", SurfaceOpenAIResponses)
	if err != nil {
		t.Fatal(err)
	}
	if target.UpstreamModelID != "wire-model" || target.Surface != SurfaceOpenAIResponses {
		t.Fatalf("target = %#v", target)
	}
	if _, err := adapter.ResolveTarget("client-model", SurfaceOpenAIChat); err == nil {
		t.Fatal("model-specific unsupported surface accepted")
	}
}

func TestOpenAIResponsesTargetIdentity(t *testing.T) {
	caps := ProviderCaps{Surfaces: []Surface{SurfaceOpenAIResponses}, Streaming: true}
	adapter := NewOpenAIAdapter(OpenAIAdapterConfig{
		ID: "custom-openai", BaseURL: "https://provider.invalid/v1",
		Surfaces: []Surface{SurfaceOpenAIResponses},
		Models:   []ProviderModel{ModelWithUpstream("client-model", "wire-model", "Client model", &caps)},
	})
	target, err := adapter.ResolveTarget("client-model", SurfaceOpenAIResponses)
	if err != nil {
		t.Fatal(err)
	}
	built, err := adapter.BuildRequest(RequestEnvelope{Target: target, Body: []byte(`{"input":[]}`)}, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if built.Endpoint.Path != "responses" || built.Auth.Headers.Get("Content-Type") != "application/json" {
		t.Fatalf("endpoint/auth = %#v / %#v", built.Endpoint, built.Auth.Headers)
	}
	var payload map[string]any
	if err := json.Unmarshal(built.Body, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["model"] != "wire-model" {
		t.Fatalf("model = %#v", payload["model"])
	}
	if _, err := adapter.AuthMaterial("secret", RouteTarget{ProviderID: "other"}); err == nil {
		t.Fatal("cross-provider target accepted")
	}
}

func TestNativeOpenAIChatClientUsesResponsesUpstream(t *testing.T) {
	caps := ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat, SurfaceOpenAIResponses}, Streaming: true, ToolCalls: true}
	adapter := NewOpenAIAdapter(OpenAIAdapterConfig{Models: []ProviderModel{Model("native", "Native", &caps)}})
	target, err := adapter.ResolveTarget("native", SurfaceOpenAIChat)
	if err != nil {
		t.Fatal(err)
	}
	built, err := adapter.BuildRequest(RequestEnvelope{Target: target, Body: []byte(`{"model":"native","messages":[{"role":"system","content":"be brief"},{"role":"user","content":"hello"}]}`)}, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if built.Endpoint.Path != "responses" {
		t.Fatalf("endpoint = %#v, want Responses", built.Endpoint)
	}
	var payload map[string]any
	if err := json.Unmarshal(built.Body, &payload); err != nil {
		t.Fatal(err)
	}
	if _, ok := payload["input"]; !ok || payload["instructions"] != "be brief" {
		t.Fatalf("payload is not Responses-shaped: %#v", payload)
	}
	if _, ok := payload["messages"]; ok {
		t.Fatalf("chat messages leaked to native Responses payload: %#v", payload)
	}
}

func TestGrokBuildBoundaryAndBodyClassification(t *testing.T) {
	caps := ProviderCaps{Surfaces: []Surface{SurfaceOpenAIResponses}, Streaming: true, Reasoning: true}
	adapter := NewGrokBuildAdapter(GrokBuildConfig{
		ID:             "grok-build",
		BaseURL:        "https://provider.invalid/v1",
		CredentialKind: CredentialOAuth,
		Models:         []ProviderModel{Model("grok-4.5", "Grok 4.5", &caps)},
	})
	target, err := adapter.ResolveTarget("grok-4.5", SurfaceOpenAIResponses)
	if err != nil {
		t.Fatal(err)
	}
	built, err := adapter.BuildRequest(RequestEnvelope{Target: target, Stream: true, Body: []byte(`{"input":[{"type":"message","role":"user","content":"hello"}],"reasoning_effort":"high"}`)}, "oauth-secret")
	if err != nil {
		t.Fatal(err)
	}
	if built.Endpoint.Path != "responses" || built.Auth.Headers.Get("x-grok-session-id") == "" || built.Auth.Headers.Get("x-grok-request-id") == "" {
		t.Fatalf("Grok request identity missing: endpoint=%#v headers=%#v", built.Endpoint, built.Auth.Headers)
	}
	var payload map[string]any
	if err := json.Unmarshal(built.Body, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["store"] != false || payload["stream"] != true {
		t.Fatalf("Grok boundary fields = %#v", payload)
	}
	include, _ := payload["include"].([]any)
	found := false
	for _, value := range include {
		if value == "reasoning.encrypted_content" {
			found = true
		}
	}
	if !found {
		t.Fatalf("encrypted reasoning include missing: %#v", payload["include"])
	}

	policy := adapter.ClassifyResponse(NewResponseEvidence(http.StatusForbidden, nil, []byte(`{"error":{"type":"content_policy","token":"oauth-secret"}}`)))
	if policy.Category != CategoryContentPolicy || policy.Retryable || strings.Contains(policy.Message, "oauth-secret") {
		t.Fatalf("policy classification = %#v", policy)
	}
	quota := adapter.ClassifyResponse(NewResponseEvidence(http.StatusTooManyRequests, nil, []byte(`{"error":{"code":"insufficient_quota","token":"oauth-secret"}}`)))
	if quota.Category != CategoryQuota || !quota.Retryable || strings.Contains(quota.Message, "oauth-secret") {
		t.Fatalf("quota classification = %#v", quota)
	}
}

func TestProviderClassificationSummaryDoesNotEchoBody(t *testing.T) {
	adapter := NewOpenAIAdapter(OpenAIAdapterConfig{Models: []ProviderModel{Model("model", "Model", nil)}})
	classified := adapter.ClassifyResponse(NewResponseEvidence(http.StatusBadRequest, nil, []byte(`{"error":{"code":"invalid_request","message":"prompt oauth-secret"}}`)))
	if classified.Message != "provider rejected the request" || strings.Contains(classified.Message, "oauth-secret") {
		t.Fatalf("classification summary = %#v", classified)
	}
}
