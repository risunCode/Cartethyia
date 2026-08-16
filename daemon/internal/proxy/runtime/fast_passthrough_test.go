package proxy

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func TestIsSameSurface(t *testing.T) {
	tests := []struct {
		source    contracts.Surface
		target    contracts.Surface
		wantEqual bool
	}{
		{contracts.SurfaceOpenAIChat, contracts.SurfaceOpenAIChat, true},
		{contracts.SurfaceOpenAIChat, contracts.SurfaceAnthropic, false},
		{contracts.SurfaceAnthropic, contracts.SurfaceAnthropic, true},
		{contracts.SurfaceGemini, contracts.SurfaceGemini, true},
		{contracts.SurfaceWebSearch, contracts.SurfaceImages, false},
	}

	for _, tt := range tests {
		got := IsSameSurface(tt.source, tt.target)
		if got != tt.wantEqual {
			t.Errorf("IsSameSurface(%q, %q) = %v, want %v", tt.source, tt.target, got, tt.wantEqual)
		}
	}
}

func TestSanitizeSameSurfaceRequest_DeveloperToSystem(t *testing.T) {
	body := `{
		"model": "gpt-4o",
		"messages": [
			{"role": "developer", "content": "You are a helpful assistant"},
			{"role": "user", "content": "Hello"}
		]
	}`

	sanitized, cleanModel, err := SanitizeSameSurfaceRequest(context.Background(), contracts.SurfaceOpenAIChat, "gpt-4o", []byte(body))
	if err != nil {
		t.Fatalf("SanitizeSameSurfaceRequest returned error: %v", err)
	}
	if cleanModel != "gpt-4o" {
		t.Errorf("expected model gpt-4o, got %q", cleanModel)
	}
	if strings.Contains(string(sanitized), `"role":"developer"`) {
		t.Errorf("expected role developer to be normalized to system, got %s", string(sanitized))
	}
}

func TestSanitizeSameSurfaceRequest_SuffixExtraction(t *testing.T) {
	body := `{
		"model": "claude-3-7-sonnet(high)",
		"messages": [
			{"role": "user", "content": "Hello"}
		]
	}`

	sanitized, cleanModel, err := SanitizeSameSurfaceRequest(context.Background(), contracts.SurfaceAnthropic, "claude-3-7-sonnet(high)", []byte(body))
	if err != nil {
		t.Fatalf("SanitizeSameSurfaceRequest returned error: %v", err)
	}
	if cleanModel != "claude-3-7-sonnet" {
		t.Errorf("expected clean model claude-3-7-sonnet, got %q", cleanModel)
	}

	var payload map[string]any
	if err := json.Unmarshal(sanitized, &payload); err != nil {
		t.Fatalf("failed to unmarshal output: %v", err)
	}
	thinkingMap, ok := payload["thinking"].(map[string]any)
	if !ok || thinkingMap["type"] != "enabled" {
		t.Errorf("expected thinking to be enabled, got %+v", payload["thinking"])
	}
}

func TestSanitizeSameSurfaceRequest_ToolHealing(t *testing.T) {
	body := `{
		"model": "gpt-4o",
		"messages": [
			{
				"role": "assistant",
				"tool_calls": [
					{
						"id": "invalid:id.123",
						"type": "function",
						"function": {"name": "bash", "arguments": "{}"}
					}
				]
			},
			{
				"role": "user",
				"content": "Next turn without tool response"
			}
		]
	}`

	sanitized, _, err := SanitizeSameSurfaceRequest(context.Background(), contracts.SurfaceOpenAIChat, "gpt-4o", []byte(body))
	if err != nil {
		t.Fatalf("SanitizeSameSurfaceRequest returned error: %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(sanitized, &payload); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}
	msgs := payload["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages after tool healing, got %d", len(msgs))
	}
	syntheticMsg := msgs[1].(map[string]any)
	if syntheticMsg["role"] != "tool" {
		t.Errorf("expected synthetic tool message, got %+v", syntheticMsg)
	}
}

func TestSanitizeSameSurfaceRequest_UnknownFieldsPreserved(t *testing.T) {
	body := `{
		"model": "gpt-4o",
		"messages": [
			{"role": "user", "content": "Hello"}
		],
		"stream_options": {"include_usage": true},
		"custom_provider_flag": "preserved",
		"beta_feature_v2": 123
	}`

	sanitized, _, err := SanitizeSameSurfaceRequest(context.Background(), contracts.SurfaceOpenAIChat, "gpt-4o", []byte(body))
	if err != nil {
		t.Fatalf("SanitizeSameSurfaceRequest returned error: %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(sanitized, &payload); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}
	if payload["custom_provider_flag"] != "preserved" {
		t.Errorf("expected custom_provider_flag preserved, got %v", payload["custom_provider_flag"])
	}
	if val, ok := payload["beta_feature_v2"].(float64); !ok || val != 123 {
		t.Errorf("expected beta_feature_v2 123, got %v", payload["beta_feature_v2"])
	}
}
