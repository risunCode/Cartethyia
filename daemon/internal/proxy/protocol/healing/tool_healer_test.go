package healing

import (
	"testing"
)

func TestSanitizeToolID(t *testing.T) {
	tests := []struct {
		id       string
		msgIdx   int
		toolIdx  int
		toolName string
		want     string
	}{
		{"call_valid_123", 0, 0, "bash", "call_valid_123"},
		{"invalid:id.with*special", 1, 2, "Read", "invalididwithspecial"},
		{"", 2, 3, "grep", "call_msg2_tc3_grep"},
		{"   ", 0, 1, "", "call_msg0_tc1"},
		{"---", 0, 0, "", "---"},
	}

	for _, tt := range tests {
		got := SanitizeToolID(tt.id, tt.msgIdx, tt.toolIdx, tt.toolName)
		if got != tt.want {
			t.Errorf("SanitizeToolID(%q) = %q, want %q", tt.id, got, tt.want)
		}
	}
}

func TestSanitizeToolIDs_OpenAI(t *testing.T) {
	messages := []map[string]any{
		{
			"role": "assistant",
			"tool_calls": []any{
				map[string]any{
					"id":   "invalid:id.1",
					"type": "function",
					"function": map[string]any{
						"name": "bash",
					},
				},
			},
		},
		{
			"role":         "tool",
			"tool_call_id": "invalid:id.1",
			"content":      "output",
		},
	}

	sanitized, changed := SanitizeToolIDs(messages)
	if !changed {
		t.Fatal("expected SanitizeToolIDs to return changed=true")
	}

	assistantTCs := sanitized[0]["tool_calls"].([]any)
	tcMap := assistantTCs[0].(map[string]any)
	if tcMap["id"] != "invalidid1" {
		t.Errorf("expected id 'invalidid1', got %q", tcMap["id"])
	}

	toolMsg := sanitized[1]
	if toolMsg["tool_call_id"] != "invalidid1" {
		t.Errorf("expected tool_call_id 'invalidid1', got %q", toolMsg["tool_call_id"])
	}
}

func TestSanitizeToolIDs_Anthropic(t *testing.T) {
	messages := []map[string]any{
		{
			"role": "assistant",
			"content": []any{
				map[string]any{
					"type": "tool_use",
					"id":   "bad id with spaces!",
					"name": "Read",
				},
			},
		},
		{
			"role": "user",
			"content": []any{
				map[string]any{
					"type":        "tool_result",
					"tool_use_id": "bad id with spaces!",
					"content":     "file content",
				},
			},
		},
	}

	sanitized, changed := SanitizeToolIDs(messages)
	if !changed {
		t.Fatal("expected SanitizeToolIDs to return changed=true")
	}

	blocks := sanitized[0]["content"].([]any)
	bMap := blocks[0].(map[string]any)
	if bMap["id"] != "badidwithspaces" {
		t.Errorf("expected id 'badidwithspaces', got %q", bMap["id"])
	}

	userBlocks := sanitized[1]["content"].([]any)
	ubMap := userBlocks[0].(map[string]any)
	if ubMap["tool_use_id"] != "badidwithspaces" {
		t.Errorf("expected tool_use_id 'badidwithspaces', got %q", ubMap["tool_use_id"])
	}
}

func TestFixMissingToolResponses_OpenAI(t *testing.T) {
	messages := []map[string]any{
		{
			"role": "assistant",
			"tool_calls": []any{
				map[string]any{
					"id":   "call_123",
					"type": "function",
					"function": map[string]any{
						"name": "bash",
					},
				},
			},
		},
		{
			"role":    "user",
			"content": "Next question without answering tool",
		},
	}

	fixed, changed := FixMissingToolResponses(messages)
	if !changed {
		t.Fatal("expected FixMissingToolResponses to return changed=true")
	}
	if len(fixed) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(fixed))
	}
	if fixed[1]["role"] != "tool" || fixed[1]["tool_call_id"] != "call_123" {
		t.Errorf("expected synthetic tool message, got %+v", fixed[1])
	}
}

func TestFixMissingToolResponses_Anthropic(t *testing.T) {
	messages := []map[string]any{
		{
			"role": "assistant",
			"content": []any{
				map[string]any{
					"type": "tool_use",
					"id":   "tu_123",
					"name": "Read",
				},
			},
		},
		{
			"role":    "user",
			"content": "Next question",
		},
	}

	fixed, changed := FixMissingToolResponses(messages)
	if !changed {
		t.Fatal("expected FixMissingToolResponses to return changed=true")
	}
	if len(fixed) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(fixed))
	}
	synthetic := fixed[1]
	if synthetic["role"] != "user" {
		t.Errorf("expected synthetic role user, got %v", synthetic["role"])
	}
	content := synthetic["content"].([]any)
	firstBlock := content[0].(map[string]any)
	if firstBlock["type"] != "tool_result" || firstBlock["tool_use_id"] != "tu_123" {
		t.Errorf("expected synthetic tool_result block, got %+v", firstBlock)
	}
}

func TestSanitizeToolArgs(t *testing.T) {
	tests := []struct {
		toolName string
		rawArgs  string
		wantSub  string
	}{
		{"Read", `{"limit": "500", "offset": "10"}`, `"limit":500`},
		{"proxy_Read", `{"limit": 5000, "offset": -5}`, `"limit":2000`},
		{"custom_tool", `{"limit": "500"}`, `{"limit": "500"}`},
	}

	for _, tt := range tests {
		got := SanitizeToolArgs(tt.toolName, tt.rawArgs)
		if tt.toolName == "Read" || tt.toolName == "proxy_Read" {
			if !testingContains(got, tt.wantSub) {
				t.Errorf("SanitizeToolArgs(%q, %q) = %q, want substring %q", tt.toolName, tt.rawArgs, got, tt.wantSub)
			}
		} else {
			if got != tt.rawArgs {
				t.Errorf("SanitizeToolArgs(%q, %q) = %q, want unchanged %q", tt.toolName, tt.rawArgs, got, tt.rawArgs)
			}
		}
	}
}

func testingContains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || (len(s) > len(sub) && testingIndex(s, sub) >= 0))
}

func testingIndex(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
