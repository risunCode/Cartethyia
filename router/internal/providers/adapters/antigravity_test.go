package adapters

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestAntigravityBuildRequestUsesCloudCodeEnvelope(t *testing.T) {
	provider := NewAntigravityAdapter(OpenAIAdapterConfig{
		ID:             "antigravity",
		BaseURL:        "https://daily-cloudcode-pa.googleapis.com",
		CredentialKind: CredentialOAuth,
		Surfaces:       []Surface{SurfaceOpenAIChat},
		Models:         []ProviderModel{{ID: "gemini-3.1-pro", UpstreamID: "gemini-pro-agent"}},
	})
	target, err := provider.ResolveTarget("gemini-3.1-pro", SurfaceOpenAIChat)
	if err != nil {
		t.Fatal(err)
	}
	credential := `{"token":"access-token","projectId":"project-123"}`
	request, err := provider.BuildRequest(RequestEnvelope{Target: target, Body: []byte(`{"system":"follow the repository rules","messages":[{"role":"user","content":"hello"}],"tools":[{"type":"function","function":{"name":"read_file","description":"Read a file","parameters":{"type":"object"}}}]}`), Headers: make(http.Header)}, credential)
	if err != nil {
		t.Fatal(err)
	}
	if request.Endpoint.Path != "v1internal:streamGenerateContent" || request.Endpoint.Query["alt"] != "sse" {
		t.Fatalf("endpoint = %#v", request.Endpoint)
	}
	if request.Auth.Headers.Get("Authorization") != "Bearer access-token" {
		t.Fatalf("authorization = %q", request.Auth.Headers.Get("Authorization"))
	}
	if request.Auth.Headers.Get("User-Agent") != "antigravity/hub/2.1.4 windows/amd64" {
		t.Fatalf("user-agent = %q", request.Auth.Headers.Get("User-Agent"))
	}
	var payload map[string]any
	if err := json.Unmarshal(request.Body, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["project"] != "project-123" || payload["model"] != "gemini-pro-agent" {
		t.Fatalf("identity = %#v", payload)
	}
	if payload["requestType"] != "agent" || payload["userAgent"] != "antigravity" {
		t.Fatalf("request identity = %#v", payload)
	}
	inner, ok := payload["request"].(map[string]any)
	if !ok {
		t.Fatalf("request = %#v", payload["request"])
	}
	instruction, ok := inner["systemInstruction"].(map[string]any)
	if !ok || instruction["role"] != "user" {
		t.Fatalf("system instruction = %#v", inner["systemInstruction"])
	}
	parts, _ := instruction["parts"].([]any)
	if len(parts) == 0 || !strings.Contains(parts[0].(map[string]any)["text"].(string), "Antigravity") {
		t.Fatalf("system instruction parts = %#v", parts)
	}
	toolConfig, _ := inner["toolConfig"].(map[string]any)
	calling, _ := toolConfig["functionCallingConfig"].(map[string]any)
	if calling["mode"] != "VALIDATED" {
		t.Fatalf("tool mode = %#v", calling)
	}
	labels, _ := inner["labels"].(map[string]any)
	if labels["last_step_index"] != "1" || labels["used_claude"] != "false" {
		t.Fatalf("labels = %#v", labels)
	}
}
