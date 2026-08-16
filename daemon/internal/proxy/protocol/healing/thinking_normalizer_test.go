package healing

import (
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func TestParseModelSuffix(t *testing.T) {
	tests := []struct {
		model      string
		wantModel  string
		wantMode   ThinkingMode
		wantBudget int
		wantLevel  string
	}{
		{"claude-3-7-sonnet(high)", "claude-3-7-sonnet", ModeLevel, 0, "high"},
		{"gemini-2.5-flash(8192)", "gemini-2.5-flash", ModeBudget, 8192, ""},
		{"gpt-4o(none)", "gpt-4o", ModeNone, 0, ""},
		{"claude-3-5-sonnet(auto)", "claude-3-5-sonnet", ModeAuto, 0, ""},
		{"claude-3-7-sonnet", "claude-3-7-sonnet", "", 0, ""},
	}

	for _, tt := range tests {
		clean, intent := ParseModelSuffix(tt.model)
		if clean != tt.wantModel {
			t.Errorf("ParseModelSuffix(%q) model = %q, want %q", tt.model, clean, tt.wantModel)
		}
		if tt.wantMode == "" {
			if intent != nil {
				t.Errorf("ParseModelSuffix(%q) expected nil intent, got %+v", tt.model, intent)
			}
		} else {
			if intent == nil {
				t.Fatalf("ParseModelSuffix(%q) expected intent, got nil", tt.model)
			}
			if intent.Mode != tt.wantMode || intent.Budget != tt.wantBudget || intent.Level != tt.wantLevel {
				t.Errorf("ParseModelSuffix(%q) intent = %+v, want mode=%v budget=%v level=%v", tt.model, intent, tt.wantMode, tt.wantBudget, tt.wantLevel)
			}
		}
	}
}

func TestExtractThinkingIntent(t *testing.T) {
	// 1. Anthropic output_config
	body1 := map[string]any{
		"output_config": map[string]any{"effort": "high"},
	}
	intent1 := ExtractThinkingIntent(body1)
	if intent1 == nil || intent1.Mode != ModeLevel || intent1.Level != "high" {
		t.Errorf("ExtractThinkingIntent(body1) = %+v, want ModeLevel high", intent1)
	}

	// 2. Anthropic thinking block
	body2 := map[string]any{
		"thinking": map[string]any{"type": "enabled", "budget_tokens": float64(4096)},
	}
	intent2 := ExtractThinkingIntent(body2)
	if intent2 == nil || intent2.Mode != ModeBudget || intent2.Budget != 4096 {
		t.Errorf("ExtractThinkingIntent(body2) = %+v, want ModeBudget 4096", intent2)
	}

	// 3. OpenAI reasoning_effort
	body3 := map[string]any{
		"reasoning_effort": "low",
	}
	intent3 := ExtractThinkingIntent(body3)
	if intent3 == nil || intent3.Mode != ModeLevel || intent3.Level != "low" {
		t.Errorf("ExtractThinkingIntent(body3) = %+v, want ModeLevel low", intent3)
	}
}

func TestApplyThinking(t *testing.T) {
	intent := &ThinkingIntent{Mode: ModeLevel, Level: "high"}

	// Apply to Anthropic
	bodyAnthropic := map[string]any{"messages": []any{}}
	ApplyThinking(contracts.SurfaceAnthropic, "claude-3-7-sonnet", bodyAnthropic, intent)
	thinkingMap, ok := bodyAnthropic["thinking"].(map[string]any)
	if !ok || thinkingMap["type"] != "enabled" || thinkingMap["budget_tokens"] != 16384 {
		t.Errorf("ApplyThinking Anthropic = %+v, want budget 16384", bodyAnthropic)
	}

	// Apply to OpenAI
	bodyOpenAI := map[string]any{"messages": []any{}}
	ApplyThinking(contracts.SurfaceOpenAIChat, "gpt-4o", bodyOpenAI, intent)
	if bodyOpenAI["reasoning_effort"] != "high" {
		t.Errorf("ApplyThinking OpenAI = %+v, want reasoning_effort high", bodyOpenAI)
	}
}

func TestStripThinkingBlocks(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "thinking", "thinking": "Let me think..."},
					map[string]any{"type": "text", "text": "Here is the answer."},
				},
			},
		},
	}

	StripThinkingBlocks(body)
	msgs := body["messages"].([]any)
	firstMsg := msgs[0].(map[string]any)
	content := firstMsg["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("expected 1 content block after stripping, got %d", len(content))
	}
	blockMap := content[0].(map[string]any)
	if blockMap["type"] != "text" {
		t.Errorf("expected remaining block to be text, got %v", blockMap["type"])
	}
}
