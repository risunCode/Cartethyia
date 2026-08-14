package adapters

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestGrokBuildParityReasoningEffortAndCompactConversion(t *testing.T) {
	caps := ProviderCaps{Surfaces: []Surface{SurfaceOpenAIResponses}, Streaming: true, Reasoning: true, ToolCalls: true}
	adapter := NewGrokBuildAdapter(GrokBuildConfig{ID: "grok-build", BaseURL: "https://grok.invalid/v1", CredentialKind: CredentialOAuth, Models: []ProviderModel{Model("grok", "Grok", &caps)}})
	for _, effort := range []string{"low", "medium", "high", "none"} {
		built, err := adapter.BuildRequest(RequestEnvelope{Target: RouteTarget{ProviderID: "grok-build", ModelID: "grok", Surface: SurfaceOpenAIResponses}, Body: []byte(`{"input":[{"type":"message","role":"user","content":"hello"}],"reasoning_effort":"` + effort + `"}`)}, "secret")
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if err := json.Unmarshal(built.Body, &payload); err != nil {
			t.Fatal(err)
		}
		reasoning, ok := payload["reasoning"].(map[string]any)
		if !ok || reasoning["effort"] != effort {
			t.Fatalf("reasoning effort = %#v", payload["reasoning"])
		}
		include, _ := payload["include"].([]any)
		foundEncrypted := false
		for _, item := range include {
			if item == "reasoning.encrypted_content" {
				foundEncrypted = true
			}
		}
		if effort != "none" && !foundEncrypted {
			t.Fatalf("encrypted reasoning include missing for %q", effort)
		}
	}
	compact, err := adapter.BuildRequest(RequestEnvelope{Target: RouteTarget{ProviderID: "grok-build", ModelID: "grok", Surface: SurfaceOpenAIResponses}, Body: []byte(`{"input":[{"type":"message","role":"user","content":"hello"}],"compact":true}`)}, "secret")
	if err != nil {
		t.Fatal(err)
	}
	var compactPayload map[string]any
	if err := json.Unmarshal(compact.Body, &compactPayload); err != nil {
		t.Fatal(err)
	}
	if compactPayload["stream"] != false || compactPayload["tool_choice"] != "none" {
		t.Fatalf("compact conversion = %#v", compactPayload)
	}
}

func TestGrokBuildRejectsMixedChatAndResponsesInput(t *testing.T) {
	caps := ProviderCaps{Surfaces: []Surface{SurfaceOpenAIResponses}, Streaming: true, Reasoning: true, ToolCalls: true}
	adapter := NewGrokBuildAdapter(GrokBuildConfig{ID: "grok-build", BaseURL: "https://grok.invalid/v1", CredentialKind: CredentialOAuth, Models: []ProviderModel{Model("grok", "Grok", &caps)}})
	if _, err := adapter.BuildRequest(RequestEnvelope{Target: RouteTarget{ProviderID: "grok-build", ModelID: "grok", Surface: SurfaceOpenAIResponses}, Body: []byte(`{"input":[{"type":"message","role":"user","content":"hello"}],"messages":[]}`)}, "secret"); err == nil {
		t.Fatal("mixed messages and input accepted")
	}
}

func TestGrokBuildParityErrorPrecedenceAndRedaction(t *testing.T) {
	adapter := NewGrokBuildAdapter(GrokBuildConfig{ID: "grok-build", BaseURL: "https://grok.invalid/v1", CredentialKind: CredentialOAuth, Models: []ProviderModel{Model("grok", "Grok", nil)}})
	cases := []struct {
		name     string
		status   int
		body     string
		category ResponseCategory
		retry    bool
	}{
		{"policy wins", http.StatusForbidden, `{"error":{"type":"content_policy","message":"secret"},"quota":"billing"}`, CategoryContentPolicy, false},
		{"entitlement", http.StatusForbidden, `{"error":{"code":"entitlement_required"}}`, CategoryEntitlement, false},
		{"free usage", http.StatusBadRequest, `{"error":{"code":"free_usage_exhausted"}}`, CategoryQuota, true},
		{"billing", http.StatusBadRequest, `{"error":{"code":"billing_required"}}`, CategoryQuota, true},
		{"empty", http.StatusOK, `{"output":[]}`, CategoryEmptyOutput, true},
		{"capacity", http.StatusServiceUnavailable, `{"error":{"code":"model_capacity"}}`, CategoryCapacity, true},
		{"rate", http.StatusTooManyRequests, `{"error":{"code":"rate_limit"}}`, CategoryRateLimit, true},
		{"server", http.StatusInternalServerError, `{"error":{"code":"server"}}`, CategoryServerError, true},
		{"validation", http.StatusBadRequest, `{"error":{"code":"invalid_request","message":"secret"}}`, CategoryInvalidRequest, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			classified := adapter.ClassifyResponse(tc.status, []byte(tc.body))
			if classified.Category != tc.category || classified.Retryable != tc.retry || strings.Contains(classified.Message, "secret") {
				t.Fatalf("classification = %#v", classified)
			}
		})
	}
}

func TestGrokBuildRejectsMalformedProtocolAndToolArguments(t *testing.T) {
	caps := ProviderCaps{Surfaces: []Surface{SurfaceOpenAIResponses}, ToolCalls: true}
	adapter := NewGrokBuildAdapter(GrokBuildConfig{ID: "grok-build", BaseURL: "https://grok.invalid/v1", CredentialKind: CredentialOAuth, Models: []ProviderModel{Model("grok", "Grok", &caps)}})
	if _, err := adapter.BuildRequest(RequestEnvelope{Target: RouteTarget{ProviderID: "grok-build", ModelID: "grok", Surface: SurfaceOpenAIResponses}, Body: []byte(`{"input":`)}, "secret"); err == nil {
		t.Fatal("malformed JSON accepted")
	}
	if _, err := adapter.BuildRequest(RequestEnvelope{Target: RouteTarget{ProviderID: "grok-build", ModelID: "grok", Surface: SurfaceOpenAIResponses}, Body: []byte(`{"input":[{"type":"message","role":"user","content":"hi"}],"tools":[{"type":"function"}]}`)}, "secret"); err == nil {
		t.Fatal("malformed function tool accepted")
	}
}
func TestGrokBuildPromptCacheIdentityIsTenantScopedAndOpaque(t *testing.T) {
	caps := ProviderCaps{Surfaces: []Surface{SurfaceOpenAIResponses}, Streaming: true, Reasoning: true}
	adapter := NewGrokBuildAdapter(GrokBuildConfig{ID: "grok-build", BaseURL: "https://grok.invalid/v1", CredentialKind: CredentialOAuth, Models: []ProviderModel{Model("grok", "Grok", &caps)}})
	build := func(tenant string) map[string]any {
		request, err := adapter.BuildRequest(RequestEnvelope{
			Target:  RouteTarget{ProviderID: "grok-build", ModelID: "grok", Surface: SurfaceOpenAIResponses},
			Headers: map[string][]string{"X-Cartethyia-Tenant": {tenant}},
			Body:    []byte(`{"input":[{"type":"message","role":"user","content":"hello"}]}`),
		}, "secret")
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if err := json.Unmarshal(request.Body, &payload); err != nil {
			t.Fatal(err)
		}
		return payload
	}
	first, second := build("tenant-a"), build("tenant-b")
	firstKey, firstOK := first["prompt_cache_key"].(string)
	secondKey, secondOK := second["prompt_cache_key"].(string)
	if !firstOK || !secondOK || firstKey == secondKey {
		t.Fatalf("tenant cache identities = %q, %q", firstKey, secondKey)
	}
	if strings.Contains(firstKey, "tenant-a") || strings.Contains(firstKey, "session") {
		t.Fatalf("raw tenant/session leaked into cache identity: %v", firstKey)
	}
}
