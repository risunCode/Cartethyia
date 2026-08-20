package adapters

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestCodexBuildRequestUsesResponsesIdentityAndCacheMetadata(t *testing.T) {
	caps := ProviderCaps{
		Surfaces:       []Surface{SurfaceOpenAIResponses},
		Streaming:      true,
		Reasoning:      true,
		ToolCalls:      true,
		ExplicitCache:  true,
		PromptCacheKey: true,
	}
	provider := NewCodexAdapter(OpenAIAdapterConfig{
		ID:             "codex",
		DisplayName:    "Codex ChatGPT",
		BaseURL:        "https://chatgpt.com/backend-api",
		CredentialKind: CredentialOAuth,
		Surfaces:       []Surface{SurfaceOpenAIResponses},
		Models:         []ProviderModel{{ID: "gpt-5.6", Capabilities: &caps}},
	})
	credential := codexTestToken(t, "acct-123")
	target, err := provider.ResolveTarget("gpt-5.6", SurfaceOpenAIResponses)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"model":"gpt-5.6","instructions":"stable system prompt","input":[{"role":"developer","content":"stable developer prompt"},{"role":"user","content":"hello"}],"max_output_tokens":128,"temperature":0.2}`)
	request, err := provider.BuildRequest(RequestEnvelope{Target: target, Body: body, Headers: make(http.Header)}, credential)
	if err != nil {
		t.Fatal(err)
	}
	if request.Endpoint.Path != "codex/responses" {
		t.Fatalf("endpoint path = %q, want codex/responses", request.Endpoint.Path)
	}
	if request.Auth.Headers.Get("OpenAI-Beta") != "responses=experimental" {
		t.Fatalf("OpenAI-Beta = %q", request.Auth.Headers.Get("OpenAI-Beta"))
	}
	if request.Auth.Headers.Get("originator") != "pi" {
		t.Fatalf("originator = %q", request.Auth.Headers.Get("originator"))
	}
	if request.Auth.Headers.Get("version") != codexClientVersion {
		t.Fatalf("version = %q", request.Auth.Headers.Get("version"))
	}
	if request.Auth.Headers.Get("chatgpt-account-id") != "acct-123" {
		t.Fatalf("chatgpt-account-id = %q", request.Auth.Headers.Get("chatgpt-account-id"))
	}
	if request.Auth.Headers.Get("session_id") == "" || request.Auth.Headers.Get("thread-id") == "" {
		t.Fatal("Codex session identity headers are missing")
	}
	var payload map[string]any
	if err := json.Unmarshal(request.Body, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["prompt_cache_key"] == "" {
		t.Fatal("prompt_cache_key is missing")
	}
	if payload["stream"] != true {
		t.Fatalf("stream = %#v, want true", payload["stream"])
	}
	for _, field := range []string{"max_output_tokens", "temperature"} {
		if _, ok := payload[field]; ok {
			t.Fatalf("Codex payload retained unsupported field %q", field)
		}
	}
	metadata, ok := payload["client_metadata"].(map[string]any)
	if !ok || strings.TrimSpace(metadata["session_id"].(string)) == "" {
		t.Fatalf("client_metadata = %#v", payload["client_metadata"])
	}
}

func codexTestToken(t *testing.T, accountID string) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	claims := map[string]any{"https://api.openai.com/auth": map[string]string{"chatgpt_account_id": accountID}}
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return header + "." + base64.RawURLEncoding.EncodeToString(body) + ".sig"
}
