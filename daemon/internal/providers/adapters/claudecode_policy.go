package adapters

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	claudeCodeVersion        = "2.1.165"
	claudeAgentSDKVersion    = "0.3.165"
	claudeClientVersion      = "1.11187.4"
	claudeOAuthVersion       = "2023-06-01"
	claudeSystemInstruction  = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
	claudeBillingPrefix      = "x-anthropic-billing-header:"
	claudeBillingPlaceholder = "cch=00000"
	claudeToolPrefix         = "_"
	claudeMaxOutputTokens    = 64000
)

var claudeOAuthBetas = []string{
	"claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14",
	"prompt-caching-scope-2026-01-05", "mid-conversation-system-2026-04-07",
	"advanced-tool-use-2025-11-20", "mcp-client-2025-11-20", "effort-2025-11-24",
	"extended-cache-ttl-2025-04-11",
}

func applyClaudeCodePolicy(wire map[string]any, input RequestEnvelope) {
	maxTokens := claudeMaxOutputTokens
	if value, ok := wire["max_tokens"].(float64); ok && int(value) < maxTokens {
		maxTokens = int(value)
	}
	wire["max_tokens"] = maxTokens
	delete(wire, "metadata")
	instruction := map[string]any{"type": "text", "text": claudeSystemInstruction}
	billing := map[string]any{"type": "text", "text": claudeBillingHeader(input)}
	switch system := wire["system"].(type) {
	case []any:
		if !containsSystemText(system, claudeSystemInstruction) {
			system = append([]any{instruction}, system...)
		}
		if !containsSystemPrefix(system, claudeBillingPrefix) {
			system = append(system, billing)
		}
		wire["system"] = system
	case string:
		wire["system"] = []any{instruction, map[string]any{"type": "text", "text": system}, billing}
	default:
		wire["system"] = []any{instruction, billing}
	}
	if tools, ok := wire["tools"].([]any); ok {
		for _, raw := range tools {
			tool, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			name, _ := tool["name"].(string)
			if name != "" && !claudeBuiltinTool(name) && !strings.HasPrefix(name, claudeToolPrefix) {
				tool["name"] = claudeToolPrefix + name
			}
		}
	}
}

func claudeBillingHeader(input RequestEnvelope) string {
	text := firstRequestUserText(input.Body)
	chars := []byte{'0', '0', '0'}
	for i, index := range []int{4, 7, 20} {
		if index < len(text) {
			chars[i] = text[index]
		}
	}
	hash := sha256.Sum256([]byte(fmt.Sprintf("59cf53e54c78%c%c%c%s", chars[0], chars[1], chars[2], claudeCodeVersion)))
	return fmt.Sprintf("%s cc_version=%s.%s; cc_entrypoint=local-agent; %s;", claudeBillingPrefix, claudeCodeVersion, hex.EncodeToString(hash[:])[:3], claudeBillingPlaceholder)
}

func attestClaudePayload(body []byte) []byte {
	if !strings.Contains(string(body), claudeBillingPlaceholder) {
		return body
	}
	hash := sha256.Sum256(body)
	cch := hex.EncodeToString(hash[:])[:5]
	return []byte(strings.Replace(string(body), claudeBillingPlaceholder, "cch="+cch, 1))
}

func firstRequestUserText(body []byte) string {
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return ""
	}
	messages, _ := payload["messages"].([]any)
	for _, raw := range messages {
		message, ok := raw.(map[string]any)
		if !ok || message["role"] != "user" {
			continue
		}
		if text, ok := message["content"].(string); ok {
			return text
		}
		if blocks, ok := message["content"].([]any); ok {
			var result strings.Builder
			for _, block := range blocks {
				if item, ok := block.(map[string]any); ok && item["type"] == "text" {
					if text, ok := item["text"].(string); ok {
						result.WriteString(text)
					}
				}
			}
			return result.String()
		}
	}
	return ""
}

func containsSystemText(blocks []any, wanted string) bool {
	for _, raw := range blocks {
		block, ok := raw.(map[string]any)
		if ok && block["text"] == wanted {
			return true
		}
	}
	return false
}

func containsSystemPrefix(blocks []any, prefix string) bool {
	for _, raw := range blocks {
		block, ok := raw.(map[string]any)
		if ok {
			text, _ := block["text"].(string)
			if strings.HasPrefix(text, prefix) {
				return true
			}
		}
	}
	return false
}

func claudeBuiltinTool(name string) bool {
	name = strings.ToLower(name)
	for _, builtin := range []string{"web_search", "web_fetch", "code_execution", "text_editor", "computer", "mcp_toolset", "tool_search_tool_regex", "tool_search_tool_bm25"} {
		if name == builtin || strings.HasPrefix(name, builtin+"_") {
			return true
		}
	}
	return false
}
