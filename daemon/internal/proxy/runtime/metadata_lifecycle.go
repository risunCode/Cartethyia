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

// completeMetadata applies the terminal outcome and timing fields shared by
// buffered dispatch returns and stream finalization. It deliberately does not
// enqueue metadata; the DispatchService lifecycle owner performs that
// fail-open side effect after this pure state transition.
func completeMetadata(meta *observability.Metadata, err error, clientCancelled bool, now time.Time) {
	if meta == nil {
		return
	}
	if err != nil {
		meta.Outcome = metadataOutcome(err)
		meta.Cancelled = clientCancelled || errors.Is(err, context.Canceled)
	}
	meta.EndedAt = now.UTC()
	meta.LatencyMS = meta.EndedAt.Sub(meta.StartedAt).Milliseconds()
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
