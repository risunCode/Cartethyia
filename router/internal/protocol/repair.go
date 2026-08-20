// Package protocol provides bounded in-place repair for same-surface protocol
// requests before they are sent upstream.
package protocol

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var toolIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
var nonToolIDChars = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

// SanitizeToolID ensures a tool call ID conforms to ^[a-zA-Z0-9_-]+$.
// If empty or unsanitizable, generates a deterministic fallback.
func SanitizeToolID(id string, msgIdx, toolIdx int, toolName string) string {
	clean := strings.TrimSpace(id)
	if clean != "" && toolIDPattern.MatchString(clean) {
		return clean
	}
	if clean != "" {
		sanitized := nonToolIDChars.ReplaceAllString(clean, "")
		if sanitized != "" {
			return sanitized
		}
	}
	cleanToolName := nonToolIDChars.ReplaceAllString(toolName, "")
	if cleanToolName != "" {
		return fmt.Sprintf("call_msg%d_tc%d_%s", msgIdx, toolIdx, cleanToolName)
	}
	return fmt.Sprintf("call_msg%d_tc%d", msgIdx, toolIdx)
}

// SanitizeToolIDs scans messages and fixes tool_calls IDs and matching tool_call_id references.
func SanitizeToolIDs(messages []map[string]any) ([]map[string]any, bool) {
	if len(messages) == 0 {
		return messages, false
	}
	changed := false
	out := make([]map[string]any, len(messages))
	idMap := make(map[string]string) // oldID -> newID

	for i, m := range messages {
		msgCopy := cloneRepairMap(m)
		role, _ := msgCopy["role"].(string)

		// 1. Assistant tool_calls (OpenAI format)
		if role == "assistant" {
			if tcs, ok := msgCopy["tool_calls"].([]any); ok && len(tcs) > 0 {
				newTCs := make([]any, len(tcs))
				for j, tcRaw := range tcs {
					if tcMap, ok := tcRaw.(map[string]any); ok {
						tcCopy := cloneRepairMap(tcMap)
						id, _ := tcCopy["id"].(string)
						var toolName string
						if fn, ok := tcCopy["function"].(map[string]any); ok {
							toolName, _ = fn["name"].(string)
						}
						sanitized := SanitizeToolID(id, i, j, toolName)
						if sanitized != id {
							if id != "" {
								idMap[id] = sanitized
							}
							tcCopy["id"] = sanitized
							changed = true
						}
						newTCs[j] = tcCopy
					} else {
						newTCs[j] = tcRaw
					}
				}
				msgCopy["tool_calls"] = newTCs
			}
		}

		// 2. Assistant tool_use blocks in content (Anthropic format)
		if contentBlocks, ok := msgCopy["content"].([]any); ok {
			newBlocks := make([]any, len(contentBlocks))
			blockChanged := false
			for k, bRaw := range contentBlocks {
				if bMap, ok := bRaw.(map[string]any); ok {
					bCopy := cloneRepairMap(bMap)
					bType, _ := bCopy["type"].(string)
					if bType == "tool_use" {
						id, _ := bCopy["id"].(string)
						toolName, _ := bCopy["name"].(string)
						sanitized := SanitizeToolID(id, i, k, toolName)
						if sanitized != id {
							if id != "" {
								idMap[id] = sanitized
							}
							bCopy["id"] = sanitized
							blockChanged = true
							changed = true
						}
					}
					newBlocks[k] = bCopy
				} else {
					newBlocks[k] = bRaw
				}
			}
			if blockChanged {
				msgCopy["content"] = newBlocks
			}
		}

		// 3. Tool role messages (OpenAI format) referencing tool_call_id
		if role == "tool" {
			if toolCallID, ok := msgCopy["tool_call_id"].(string); ok {
				if mappedID, ok := idMap[toolCallID]; ok {
					msgCopy["tool_call_id"] = mappedID
					changed = true
				} else if !toolIDPattern.MatchString(toolCallID) {
					sanitized := SanitizeToolID(toolCallID, i, 0, "")
					msgCopy["tool_call_id"] = sanitized
					changed = true
				}
			}
		}

		// 4. Tool result blocks in content (Anthropic format) referencing tool_use_id
		if contentBlocks, ok := msgCopy["content"].([]any); ok {
			newBlocks := make([]any, len(contentBlocks))
			blockChanged := false
			for k, bRaw := range contentBlocks {
				if bMap, ok := bRaw.(map[string]any); ok {
					bCopy := cloneRepairMap(bMap)
					bType, _ := bCopy["type"].(string)
					if bType == "tool_result" {
						if toolUseID, ok := bCopy["tool_use_id"].(string); ok {
							if mappedID, ok := idMap[toolUseID]; ok {
								bCopy["tool_use_id"] = mappedID
								blockChanged = true
								changed = true
							} else if !toolIDPattern.MatchString(toolUseID) {
								sanitized := SanitizeToolID(toolUseID, i, k, "")
								bCopy["tool_use_id"] = sanitized
								blockChanged = true
								changed = true
							}
						}
					}
					newBlocks[k] = bCopy
				} else {
					newBlocks[k] = bRaw
				}
			}
			if blockChanged {
				msgCopy["content"] = newBlocks
			}
		}

		out[i] = msgCopy
	}

	if !changed {
		return messages, false
	}
	return out, true
}

// FixMissingToolResponses detects when an assistant message has tool calls but the subsequent
// turn does not provide tool results, inserting synthetic tool responses to prevent provider 400s.
func FixMissingToolResponses(messages []map[string]any) ([]map[string]any, bool) {
	if len(messages) == 0 {
		return messages, false
	}
	var out []map[string]any
	changed := false

	for i := range len(messages) {
		msg := messages[i]
		out = append(out, msg)
		role, _ := msg["role"].(string)

		if role != "assistant" {
			continue
		}

		// Collect tool call IDs from this assistant message
		var openaiToolCallIDs []string
		var anthropicToolUseIDs []string

		if tcs, ok := msg["tool_calls"].([]any); ok {
			for _, tcRaw := range tcs {
				if tcMap, ok := tcRaw.(map[string]any); ok {
					if id, ok := tcMap["id"].(string); ok && id != "" {
						openaiToolCallIDs = append(openaiToolCallIDs, id)
					}
				}
			}
		}

		if contentBlocks, ok := msg["content"].([]any); ok {
			for _, bRaw := range contentBlocks {
				if bMap, ok := bRaw.(map[string]any); ok {
					if bType, _ := bMap["type"].(string); bType == "tool_use" {
						if id, ok := bMap["id"].(string); ok && id != "" {
							anthropicToolUseIDs = append(anthropicToolUseIDs, id)
						}
					}
				}
			}
		}

		if len(openaiToolCallIDs) == 0 && len(anthropicToolUseIDs) == 0 {
			continue
		}

		// Look ahead to check if the subsequent messages answer these tool calls
		answeredOpenAI := make(map[string]bool)
		answeredAnthropic := make(map[string]bool)

		for j := i + 1; j < len(messages); j++ {
			nextMsg := messages[j]
			nextRole, _ := nextMsg["role"].(string)

			if nextRole == "tool" {
				if tID, ok := nextMsg["tool_call_id"].(string); ok {
					answeredOpenAI[tID] = true
				}
			}
			if contentBlocks, ok := nextMsg["content"].([]any); ok {
				for _, bRaw := range contentBlocks {
					if bMap, ok := bRaw.(map[string]any); ok {
						if bType, _ := bMap["type"].(string); bType == "tool_result" {
							if tID, ok := bMap["tool_use_id"].(string); ok {
								answeredAnthropic[tID] = true
							}
						}
					}
				}
			}
			// If we hit another assistant message before answering, stop looking
			if nextRole == "assistant" {
				break
			}
		}

		// Inject synthetic responses for missing OpenAI tool calls
		for _, tcID := range openaiToolCallIDs {
			if !answeredOpenAI[tcID] {
				out = append(out, map[string]any{
					"role":         "tool",
					"tool_call_id": tcID,
					"content":      "[Tool execution was interrupted or omitted by client]",
				})
				changed = true
			}
		}

		// Inject synthetic responses for missing Anthropic tool use
		if len(anthropicToolUseIDs) > 0 {
			var missingAnthropicIDs []string
			for _, tuID := range anthropicToolUseIDs {
				if !answeredAnthropic[tuID] {
					missingAnthropicIDs = append(missingAnthropicIDs, tuID)
				}
			}
			if len(missingAnthropicIDs) > 0 {
				syntheticBlocks := make([]any, len(missingAnthropicIDs))
				for idx, tuID := range missingAnthropicIDs {
					syntheticBlocks[idx] = map[string]any{
						"type":        "tool_result",
						"tool_use_id": tuID,
						"content":     "[Tool execution was interrupted or omitted by client]",
					}
				}
				out = append(out, map[string]any{
					"role":    "user",
					"content": syntheticBlocks,
				})
				changed = true
			}
		}
	}

	if !changed {
		return messages, false
	}
	return out, true
}

// SanitizeToolArgs coerces string parameters for well-known tools (e.g. Read limit/offset).
func SanitizeToolArgs(toolName string, rawArgs string) string {
	if rawArgs == "" {
		return rawArgs
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
		return rawArgs
	}

	name := strings.TrimPrefix(toolName, "proxy_")
	changed := false

	if name == "Read" || name == "read" {
		// Coerce limit string to number and clamp between 1 and 2000
		if limitStr, ok := args["limit"].(string); ok {
			if num, err := strconv.Atoi(strings.TrimSpace(limitStr)); err == nil {
				args["limit"] = num
				changed = true
			}
		}
		if limitNum, ok := args["limit"].(float64); ok {
			if limitNum > 2000 {
				args["limit"] = 2000
				changed = true
			} else if limitNum < 1 {
				delete(args, "limit")
				changed = true
			}
		}

		// Coerce offset string to number and ensure >= 0
		if offsetStr, ok := args["offset"].(string); ok {
			if num, err := strconv.Atoi(strings.TrimSpace(offsetStr)); err == nil {
				args["offset"] = num
				changed = true
			}
		}
		if offsetNum, ok := args["offset"].(float64); ok {
			if offsetNum < 0 {
				args["offset"] = 0
				changed = true
			}
		}
	}

	if !changed {
		return rawArgs
	}
	marshaled, err := json.Marshal(args)
	if err != nil {
		return rawArgs
	}
	return string(marshaled)
}
