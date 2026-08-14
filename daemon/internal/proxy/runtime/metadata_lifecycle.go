package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func requestMetadata(req contracts.Request) observability.Metadata {
	meta := observability.Metadata{
		RequestID: headerValue(req.Headers, "X-Request-ID"),
		Provider:  headerValue(req.Headers, "X-Cartethyia-Provider"),
		Model:     req.Model,
		Surface:   string(req.Protocol),
		Outcome:   observability.OutcomeSuccess,
		StartedAt: time.Now().UTC(),
	}
	var payload map[string]any
	if json.Unmarshal(req.Body, &payload) != nil || payload == nil {
		return meta
	}
	if messages, ok := payload["messages"].([]any); ok {
		meta.MessageCount = len(messages)
		for _, raw := range messages {
			message, _ := raw.(map[string]any)
			if message == nil {
				continue
			}
			if content, ok := message["content"].([]any); ok {
				for _, blockRaw := range content {
					block, _ := blockRaw.(map[string]any)
					if block == nil {
						continue
					}
					if typ, _ := block["type"].(string); typ == "image_url" || typ == "input_image" {
						meta.ImageCount++
					}
				}
			}
		}
	} else if input, ok := payload["input"].([]any); ok {
		meta.MessageCount = len(input)
		for _, raw := range input {
			item, _ := raw.(map[string]any)
			if item == nil {
				continue
			}
			if typ, _ := item["type"].(string); typ == "input_image" {
				meta.ImageCount++
			}
		}
	}
	if tools, ok := payload["tools"].([]any); ok {
		meta.ToolCount = len(tools)
		for _, raw := range tools {
			tool, _ := raw.(map[string]any)
			if tool == nil {
				continue
			}
			name, _ := tool["name"].(string)
			if name == "" {
				if fn, ok := tool["function"].(map[string]any); ok {
					name, _ = fn["name"].(string)
				}
			}
			meta.ToolNames = append(meta.ToolNames, name)
		}
	}
	return meta
}

func applyResponseMetadata(meta *observability.Metadata, body []byte) {
	if meta == nil {
		return
	}
	tokens := parseUsage(body)
	meta.InputTokens = tokens.Input
	meta.OutputTokens = tokens.Output
	meta.CachedTokens = tokens.CachedRead
	meta.CacheWriteTokens = tokens.CachedWrite
}

func metadataOutcome(err error) observability.Outcome {
	if err == nil {
		return observability.OutcomeSuccess
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return observability.OutcomeCancelled
	}
	var routeErr *contracts.RouteError
	if errors.As(err, &routeErr) {
		switch routeErr.Kind {
		case contracts.ErrorAuthentication:
			return observability.OutcomeAuthFailed
		case contracts.ErrorRateLimit:
			return observability.OutcomeQuota
		}
	}
	return observability.OutcomeError
}
