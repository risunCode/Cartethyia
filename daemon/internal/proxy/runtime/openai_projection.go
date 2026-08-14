package proxy

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// projectNativeResponsesToChat converts a native Responses response into the
// Chat Completions projection requested by the client. Providers that already
// return Chat Completions JSON are left untouched. The projection is
// payload-shape driven so compatible providers do not need provider-specific
// coupling in the dispatch layer.
func projectNativeResponsesToChat(req contracts.Request, response *contracts.Response) *contracts.Response {
	if response == nil || req.Protocol != contracts.SurfaceOpenAIChat {
		return response
	}
	var native map[string]any
	if err := json.Unmarshal(response.Body, &native); err != nil || native == nil {
		return response
	}
	if object, _ := native["object"].(string); object != "response" {
		if _, ok := native["output"]; !ok {
			return response
		}
	}
	projected, err := responsesObjectToChat(native)
	if err != nil {
		return response
	}
	body, err := json.Marshal(projected)
	if err != nil {
		return response
	}
	out := *response
	out.Body = body
	out.Headers = response.Headers.Clone()
	if out.Headers == nil {
		out.Headers = make(map[string][]string)
	}
	out.Headers.Set("Content-Type", "application/json")
	return &out
}

func responsesObjectToChat(native map[string]any) (map[string]any, error) {
	id := stringValue(native["id"])
	if id == "" {
		id = "response"
	}
	model := stringValue(native["model"])
	created := integerValue(native["created_at"])
	if created == 0 {
		created = integerValue(native["created"])
	}
	choice := map[string]any{
		"index":         0,
		"message":       map[string]any{"role": "assistant", "content": ""},
		"finish_reason": finishReason(native),
	}
	message := choice["message"].(map[string]any)
	var toolCalls []any
	var text strings.Builder
	var reasoning strings.Builder
	var media []any
	output, _ := native["output"].([]any)
	for _, raw := range output {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch stringValue(item["type"]) {
		case "message", "output_text":
			if content, ok := item["content"].([]any); ok {
				for _, blockRaw := range content {
					block, ok := blockRaw.(map[string]any)
					if !ok {
						continue
					}
					switch stringValue(block["type"]) {
					case "reasoning", "reasoning_text":
						reasoning.WriteString(stringValue(block["text"]))
					case "output_image", "image":
						if value := stringValue(block["url"]); value != "" {
							media = append(media, map[string]any{"type": "image_url", "image_url": map[string]any{"url": value}})
						}
					default:
						text.WriteString(stringValue(block["text"]))
					}
				}
			} else if value := stringValue(item["text"]); value != "" {
				text.WriteString(value)
			}
		case "reasoning":
			if summary, ok := item["summary"].([]any); ok {
				for _, rawSummary := range summary {
					if summaryItem, ok := rawSummary.(map[string]any); ok {
						reasoning.WriteString(stringValue(summaryItem["text"]))
					}
				}
			}
		case "output_image":
			if value := stringValue(item["url"]); value != "" {
				media = append(media, map[string]any{"type": "image_url", "image_url": map[string]any{"url": value}})
			}
		case "function_call":
			name := stringValue(item["name"])
			arguments := stringValue(item["arguments"])
			callID := stringValue(item["call_id"])
			if callID == "" {
				callID = stringValue(item["id"])
			}
			toolCalls = append(toolCalls, map[string]any{
				"id":   callID,
				"type": "function",
				"function": map[string]any{
					"name":      name,
					"arguments": arguments,
				},
			})
		}
	}
	if len(media) > 0 {
		content := make([]any, 0, len(media)+1)
		if text.Len() > 0 {
			content = append(content, map[string]any{"type": "text", "text": text.String()})
		}
		content = append(content, media...)
		message["content"] = content
	} else {
		message["content"] = text.String()
	}
	if reasoning.Len() > 0 {
		message["reasoning_content"] = reasoning.String()
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
		choice["finish_reason"] = "tool_calls"
	}
	usage := projectUsage(native["usage"])
	return map[string]any{
		"id":      id,
		"object":  "chat.completion",
		"created": created,
		"model":   model,
		"choices": []any{choice},
		"usage":   usage,
	}, nil
}

func finishReason(native map[string]any) string {
	status := stringValue(native["status"])
	switch status {
	case "incomplete":
		return "length"
	case "failed":
		return "stop"
	default:
		return "stop"
	}
}

func projectUsage(raw any) map[string]any {
	usage, _ := raw.(map[string]any)
	if usage == nil {
		return map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
	}
	input := integerValue(usage["input_tokens"])
	output := integerValue(usage["output_tokens"])
	result := map[string]any{
		"prompt_tokens":     input,
		"completion_tokens": output,
		"total_tokens":      integerValue(usage["total_tokens"]),
	}
	if result["total_tokens"].(int64) == 0 {
		result["total_tokens"] = input + output
	}
	if cached := integerValue(usage["input_tokens_details"]); cached != 0 {
		result["prompt_tokens_details"] = map[string]any{"cached_tokens": cached}
	}
	return result
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func integerValue(value any) int64 {
	switch v := value.(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		parsed, _ := v.Int64()
		return parsed
	case string:
		parsed, _ := strconv.ParseInt(v, 10, 64)
		return parsed
	case map[string]any:
		if cached, ok := v["cached_tokens"]; ok {
			return integerValue(cached)
		}
	}
	return 0
}
